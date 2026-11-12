import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { createTransport } from "nodemailer";
import type { EMAIL_TEST_FAILURES } from "@prospecting/contracts";
import type { EmailAdapter, OutboundEmail } from "../campaigns/channels.js";

export type SmtpAccount = Readonly<{ host: string; port: number; secure: boolean; username: string; password: string; fromName: string | null; fromEmail: string; replyTo: string | null }>;
export type SmtpFailure = (typeof EMAIL_TEST_FAILURES)[number];

/** AES-256-GCM with the organization id as associated data: a ciphertext copied to another tenant's row does not decrypt. */
export function sealSecret(key: Buffer, plain: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}
export function openSecret(key: Buffer, stored: string, aad: string): string {
  const [version, iv, tag, body] = stored.split(".");
  if (version !== "v1" || !iv || !tag || body === undefined) throw new Error("unsupported ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

// The host is tenant input, so the server must not be usable to reach its own network (SSRF): loopback, private, link-local and metadata ranges are refused.
const internal = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) internal.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) internal.addSubnet(net, bits, "ipv6");
// IPv4-mapped IPv6 (::ffff:a.b.c.d) is refused by text: as a BlockList subnet it would also match every plain IPv4 address.
const isInternal = (address: string, family: number) => /^::ffff:/i.test(address) || internal.check(address, family === 6 ? "ipv6" : "ipv4");

/** Test/dev escape hatch for a local SMTP stub (plain text, loopback). Never honoured in production. */
export const insecureLocalAllowed = (env: NodeJS.ProcessEnv = process.env) => env.SMTP_ALLOW_INSECURE_LOCAL === "1" && env.NODE_ENV !== "production";

export class SmtpHostNotAllowed extends Error {}

/** Resolves the host once and returns the address to connect to, so the check and the connection use the same IP (no DNS rebinding). */
export async function resolveSmtpHost(host: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new SmtpHostNotAllowed("host does not resolve");
  if (!insecureLocalAllowed(env) && addresses.some((a) => isInternal(a.address, a.family))) throw new SmtpHostNotAllowed("internal address");
  return (addresses[0] as { address: string }).address;
}

export function classifySmtpError(e: unknown): SmtpFailure {
  if (e instanceof SmtpHostNotAllowed) return "host_not_allowed";
  const err = e as { code?: string; responseCode?: number; message?: string };
  if (err.code === "EAUTH" || err.responseCode === 535 || err.responseCode === 534) return "auth_failed";
  if (err.code === "ETLS" || /certificate|tls|ssl/i.test(err.message ?? "")) return "tls_failed";
  if (["ESOCKET", "ECONNECTION", "ETIMEDOUT", "EDNS", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND"].includes(err.code ?? "")) return "connection_failed";
  if (err.code === "EENVELOPE" || err.code === "EMESSAGE" || (err.responseCode ?? 0) >= 400) return "rejected";
  return "unknown";
}

async function transport(account: SmtpAccount, env: NodeJS.ProcessEnv) {
  const address = await resolveSmtpHost(account.host, env);
  const local = insecureLocalAllowed(env);
  return createTransport({
    host: address,
    port: account.port,
    secure: account.secure,
    auth: { user: account.username, pass: account.password },
    // Port 465 is implicit TLS; any other port must upgrade with STARTTLS before the password is sent.
    requireTLS: !account.secure && !local,
    ignoreTLS: !account.secure && local,
    tls: { servername: account.host, minVersion: "TLSv1.2" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

/** Connects and logs in without sending anything. */
export async function verifySmtp(account: SmtpAccount, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const t = await transport(account, env);
  try {
    await t.verify();
  } finally {
    t.close();
  }
}

/**
 * Overall deadline for one SMTP send (DNS + connect + TLS + auth + DATA). The per-phase timeouts in `transport` do not bound the total, and the
 * send runs inside a transaction limited to SEND_TX_TIMEOUT_MS (60 s, campaigns/channels.ts): this keeps the SMTP side safely below it.
 */
export const SMTP_SEND_DEADLINE_MS = 45_000;

export class SmtpSendTimeout extends Error {
  readonly code = "ETIMEDOUT";
}

/**
 * One tenant's SMTP mailbox behind the common adapter shape. SMTP has no idempotency: the Message-ID is derived from the key so a duplicate
 * after a crash is at least recognisable; delivery is at-least-once. Asynchronous bounces go to the mailbox, not to this system.
 */
export class SmtpEmailAdapter implements EmailAdapter {
  readonly name = "smtp";
  constructor(private readonly account: SmtpAccount, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async send(email: OutboundEmail): Promise<{ messageId: string }> {
    const domain = this.account.fromEmail.split("@")[1] ?? "localhost";
    const messageId = `<${createHash("sha256").update(email.idempotencyKey).digest("hex").slice(0, 32)}@${domain}>`;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SmtpSendTimeout("SMTP send exceeded its deadline")), SMTP_SEND_DEADLINE_MS);
    });
    let t: Awaited<ReturnType<typeof transport>> | undefined;
    try {
      t = await Promise.race([transport(this.account, this.env), deadline]);
      await Promise.race([t.sendMail({
        from: this.account.fromName ? { name: this.account.fromName, address: this.account.fromEmail } : this.account.fromEmail,
        to: email.to,
        ...(this.account.replyTo ? { replyTo: this.account.replyTo } : {}),
        subject: email.subject,
        text: email.body,
        messageId,
        ...(email.unsubscribeUrl ? { headers: { "List-Unsubscribe": `<${email.unsubscribeUrl}>` } } : {}),
      }), deadline]);
      return { messageId };
    } finally {
      clearTimeout(timer);
      t?.close();
    }
  }
}

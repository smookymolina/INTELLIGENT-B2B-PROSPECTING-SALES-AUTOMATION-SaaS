import { randomUUID } from "node:crypto";
import net from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MembershipRole } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { CampaignsService } from "../campaigns/campaigns.service.js";
import { EmailChannels } from "../campaigns/channels.js";
import { DraftDeliveryService } from "../drafts/draft-delivery.service.js";
import { SmtpHostNotAllowed, resolveSmtpHost } from "../email-settings/smtp.js";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** Per-organization SMTP: encrypted password, isolation between tenants, connection test and real delivery to a local SMTP stub. */
let api: Api;
const PORT = 2525;
const SMTP_USER = "ventas@stub.example";
const SMTP_PASS = "S3cret-stub-password*";
type Received = { from: string; to: string[]; data: string };
const received: Received[] = [];
let stub: net.Server;

/** Minimal plain-text SMTP server (EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA). Enough for nodemailer; nothing leaves the machine. */
function startStub(): Promise<net.Server> {
  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let loginStep = 0;
    let loginUser = "";
    let current: Received = { from: "", to: [], data: "" };
    const say = (line: string) => socket.write(`${line}\r\n`);
    const check = (user: string, pass: string) => say(user === SMTP_USER && pass === SMTP_PASS ? "235 2.7.0 ok" : "535 5.7.8 bad credentials");
    say("220 stub ESMTP");
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push(current);
          current = { from: "", to: [], data: "" };
          say("250 2.0.0 queued");
          continue;
        }
        const nl = buffer.indexOf("\r\n");
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const upper = line.toUpperCase();
        if (loginStep === 1) { loginUser = Buffer.from(line, "base64").toString(); loginStep = 2; say("334 UGFzc3dvcmQ6"); }
        else if (loginStep === 2) { loginStep = 0; check(loginUser, Buffer.from(line, "base64").toString()); }
        else if (upper.startsWith("EHLO")) { say("250-stub"); say("250 AUTH PLAIN LOGIN"); }
        else if (upper.startsWith("AUTH PLAIN")) { const [, user = "", pass = ""] = Buffer.from(line.slice(11), "base64").toString().split("\u0000"); check(user, pass); }
        else if (upper.startsWith("AUTH LOGIN")) { loginStep = 1; say("334 VXNlcm5hbWU6"); }
        else if (upper.startsWith("MAIL FROM:")) { current.from = line.slice(10).replace(/[<>]/g, "").split(" ")[0] ?? ""; say("250 ok"); }
        else if (upper.startsWith("RCPT TO:")) { current.to.push(line.slice(8).replace(/[<>]/g, "")); say("250 ok"); }
        else if (upper === "DATA") { inData = true; say("354 go"); }
        else if (upper === "QUIT") { say("221 bye"); socket.end(); }
        else say("250 ok");
      }
    });
  });
  return new Promise((resolve, reject) => server.once("error", reject).listen(PORT, "127.0.0.1", () => resolve(server)));
}

type Account = { token: string; orgId: string; userId: string };
const workerCtx = (a: Account): AuthContext => ({ sessionId: "worker", userId: a.userId, organizationId: a.orgId, role: "org_admin", requestId: "job:test" });
const workerDispatch = (a: Account, id: string) => api.app.get(CampaignsService).dispatch(workerCtx(a), id, 50, { worker: true });
async function register(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label}` } });
  const me = await api.call("GET", "/me", { token: res.body.token });
  return { token: res.body.token, orgId: res.body.organization.id, userId: me.body.user.id };
}
async function member(orgId: string, role: MembershipRole) {
  const m = await seedMember(orgId, role);
  return (await api.call("POST", "/auth/login", { body: { email: m.email, password: PASSWORD } })).body.token as string;
}
const settings = (over: Record<string, unknown> = {}) => ({ host: "127.0.0.1", port: PORT, secure: false, username: SMTP_USER, password: SMTP_PASS, fromName: "Ventas Stub", fromEmail: SMTP_USER, ...over });
const put = (t: string, body: Record<string, unknown>) => api.call("PUT", "/organization/email-settings", { token: t, body });
const get = (t: string) => api.call("GET", "/organization/email-settings", { token: t });
const test = (t: string, body: Record<string, unknown> = {}) => api.call("POST", "/organization/email-settings/test", { token: t, body });

beforeAll(async () => {
  process.env.SMTP_ALLOW_INSECURE_LOCAL = "1";
  stub = await startStub();
  api = await startApi();
});
afterAll(async () => {
  delete process.env.SMTP_ALLOW_INSECURE_LOCAL;
  delete process.env.EMAIL_PROVIDER;
  await api.close();
  await new Promise((r) => stub.close(r));
});
beforeEach(() => {
  received.length = 0;
  delete process.env.EMAIL_PROVIDER;
});

describe("per-organization SMTP settings", () => {
  it("stores the password encrypted and never returns it", async () => {
    const a = await register("smtp-save");
    expect((await get(a.token)).body).toMatchObject({ configured: false, hasPassword: false, host: null });
    const saved = await put(a.token, settings());
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ configured: true, hasPassword: true, host: "127.0.0.1", port: PORT, username: SMTP_USER, fromEmail: SMTP_USER, verifiedAt: null });
    expect(JSON.stringify(saved.body)).not.toContain(SMTP_PASS);
    expect(JSON.stringify((await get(a.token)).body)).not.toContain(SMTP_PASS);
    const row = (await owner.query("SELECT password_enc FROM email_settings WHERE organization_id = $1", [a.orgId])).rows[0] as { password_enc: string };
    expect(row.password_enc.startsWith("v1.")).toBe(true);
    expect(row.password_enc).not.toContain(SMTP_PASS);
    const audit = await owner.query("SELECT metadata::text AS m FROM audit_events WHERE organization_id = $1 AND action = 'email_settings.updated'", [a.orgId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].m).not.toContain(SMTP_PASS);
    expect(audit.rows[0].m).toContain("passwordChanged");
  });

  it("validates input and only reuses the stored password for the same server and login", async () => {
    const a = await register("smtp-validate");
    expect((await put(a.token, settings({ port: 22 }))).status).toBe(400);
    expect((await put(a.token, settings({ host: "bad host" }))).status).toBe(400);
    expect((await put(a.token, settings({ fromName: "Evil\r\nBcc: x@y.example" }))).status).toBe(400);
    const { password: _omit, ...withoutPassword } = settings();
    void _omit;
    expect((await put(a.token, withoutPassword)).status).toBe(400); // nothing stored yet
    expect((await put(a.token, settings())).status).toBe(200);
    expect((await put(a.token, { ...withoutPassword, fromName: "Otro nombre" })).status).toBe(200); // same server: stored password kept
    expect((await put(a.token, { ...withoutPassword, host: "smtp.attacker.example" })).status).toBe(400); // a new host never receives the old password
    expect((await test(a.token)).body).toMatchObject({ ok: true }); // the kept password still works
  });

  it("is limited to organization:update and isolated between organizations", async () => {
    const a = await register("smtp-iso-a");
    const b = await register("smtp-iso-b");
    expect((await put(a.token, settings())).status).toBe(200);
    for (const role of ["seller", "analyst", "campaign_manager"] as const) {
      const t = await member(a.orgId, role);
      expect((await get(t)).status).toBe(403);
      expect((await put(t, settings())).status).toBe(403);
      expect((await test(t)).status).toBe(403);
    }
    expect((await get(b.token)).body).toMatchObject({ configured: false });
    expect((await test(b.token)).status).toBe(409);
    expect(await asRuntime({ organizationId: b.orgId, role: "org_admin" }, async (c) => (await c.query("SELECT count(*)::int AS n FROM email_settings")).rows[0].n)).toBe(0);
    expect(await asRuntime({ organizationId: a.orgId, role: "org_admin" }, async (c) => (await c.query("SELECT count(*)::int AS n FROM email_settings")).rows[0].n)).toBe(1);
    expect(await asRuntime({}, async (c) => (await c.query("SELECT count(*)::int AS n FROM email_settings")).rows[0].n)).toBe(0);
    const foreign = await asRuntime({ organizationId: b.orgId, role: "org_admin" }, (c) =>
      c.query("INSERT INTO email_settings (organization_id, host, port, secure, username, password_enc, from_email) VALUES ($1, 'x.example', 587, false, 'u', 'v1.a.b.c', 'a@x.example')", [a.orgId]).then(() => "inserted", () => "denied"));
    expect(foreign).toBe("denied");
    expect((await api.call("DELETE", "/organization/email-settings", { token: b.token })).status).toBe(200);
    expect((await get(a.token)).body).toMatchObject({ configured: true }); // B's delete did not touch A
  });

  it("tests the connection, reports a failure category and can send one test message", async () => {
    const a = await register("smtp-test");
    await put(a.token, settings({ password: "wrong-password" }));
    expect((await test(a.token)).body).toMatchObject({ ok: false, sent: false, failure: "auth_failed", verifiedAt: null });
    await put(a.token, settings());
    const ok = await test(a.token, { sendTo: "destino@cliente.example" });
    expect(ok.body).toMatchObject({ ok: true, sent: true, failure: null });
    expect((await get(a.token)).body.verifiedAt).toBe(ok.body.verifiedAt);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ from: SMTP_USER, to: ["destino@cliente.example"] });
    await put(a.token, settings({ fromName: "Cambio" }));
    expect((await get(a.token)).body.verifiedAt).toBeNull(); // any change resets the verification
  });

  it("refuses internal addresses unless the local test switch is on", async () => {
    await expect(resolveSmtpHost("127.0.0.1", {})).rejects.toBeInstanceOf(SmtpHostNotAllowed);
    await expect(resolveSmtpHost("10.1.2.3", {})).rejects.toBeInstanceOf(SmtpHostNotAllowed);
    await expect(resolveSmtpHost("169.254.169.254", {})).rejects.toBeInstanceOf(SmtpHostNotAllowed);
    await expect(resolveSmtpHost("::ffff:127.0.0.1", {})).rejects.toBeInstanceOf(SmtpHostNotAllowed);
    await expect(resolveSmtpHost("::1", {})).rejects.toBeInstanceOf(SmtpHostNotAllowed);
    await expect(resolveSmtpHost("8.8.8.8", {})).resolves.toBe("8.8.8.8"); // public addresses stay reachable
    await expect(resolveSmtpHost("2001:4860:4860::8888", {})).resolves.toBe("2001:4860:4860::8888");
    await expect(resolveSmtpHost("127.0.0.1", { SMTP_ALLOW_INSECURE_LOCAL: "1", NODE_ENV: "production" })).rejects.toBeInstanceOf(SmtpHostNotAllowed);
    await expect(resolveSmtpHost("127.0.0.1", { SMTP_ALLOW_INSECURE_LOCAL: "1" })).resolves.toBe("127.0.0.1");
  });
});

describe("campaign delivery through the organization's SMTP", () => {
  async function campaignWithContact(t: string) {
    const domain = `smtp-${randomUUID().slice(0, 8)}.example`;
    const p = (await api.call("POST", "/prospects", { token: t, body: { name: "Cliente SMTP", domain } })).body as { id: string };
    const c = (await api.call("POST", `/prospects/${p.id}/contacts`, { token: t, body: { address: `compras@${domain}`, displayName: "Compras", source: "Formulario web, 2026-09-01" } })).body as { id: string };
    await api.call("POST", `/contacts/${c.id}/consent`, { token: t, body: { event: "granted", evidence: "Casilla marcada en el formulario web", occurredAt: new Date(Date.now() - 60_000).toISOString() } });
    const id = (await api.call("POST", "/campaigns", { token: t, body: { name: "SMTP", subject: "Hola {{company}}", body: "Oferta para {{company}}. Baja: {{unsubscribe_url}}" } })).body.id as string;
    await api.call("POST", `/campaigns/${id}/approve`, { token: t });
    await api.call("POST", `/campaigns/${id}/launch`, { token: t });
    return { id, address: `compras@${domain}` };
  }

  it("sends with the tenant's account (From, List-Unsubscribe) and records provider smtp; other tenants are unaffected", async () => {
    const a = await register("smtp-send-a");
    const b = await register("smtp-send-b");
    await put(a.token, settings());
    const ca = await campaignWithContact(a.token);
    const sent = await api.app.get(EmailChannels).sandbox.outbox.length;
    expect((await api.call("POST", `/campaigns/${ca.id}/dispatch`, { token: a.token })).status).toBe(409); // real mail never leaves inside an HTTP request
    expect(received).toHaveLength(0);
    expect(await workerDispatch(a, ca.id)).toMatchObject({ sent: 1, failed: 0 });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ from: SMTP_USER, to: [ca.address] });
    expect(received[0]?.data).toMatch(/^From: "?Ventas Stub"? <ventas@stub\.example>/m);
    expect(received[0]?.data).toMatch(/^List-Unsubscribe:\s+<http/m);
    expect(received[0]?.data).toContain("Subject: Hola Cliente SMTP");
    expect(api.app.get(EmailChannels).sandbox.outbox.length).toBe(sent); // nothing went to the sandbox
    const attempt = (await owner.query("SELECT state, provider, provider_message_id FROM send_attempts WHERE campaign_id = $1", [ca.id])).rows[0];
    expect(attempt).toMatchObject({ state: "sent", provider: "smtp" });
    expect(attempt.provider_message_id).toMatch(/^<[0-9a-f]{32}@stub\.example>$/);

    // B has no SMTP account and no process provider: a clean 503, and nothing reaches A's mailbox.
    const cb = await campaignWithContact(b.token);
    expect((await api.call("POST", `/campaigns/${cb.id}/dispatch`, { token: b.token })).status).toBe(503);
    expect(received).toHaveLength(1);
  });

  it("approved draft: a person queues it, only the worker sends it, and consent is re-checked at send time", async () => {
    const a = await register("smtp-draft");
    const b = await register("smtp-draft-b");
    await put(a.token, settings());
    const mk = async () => {
      const domain = `drf-${randomUUID().slice(0, 8)}.example`;
      const p = (await api.call("POST", "/prospects", { token: a.token, body: { name: "Cliente Borrador", domain } })).body as { id: string };
      const c = (await api.call("POST", `/prospects/${p.id}/contacts`, { token: a.token, body: { address: `compras@${domain}`, displayName: "Compras", source: "Formulario web" } })).body as { id: string };
      await api.call("POST", `/contacts/${c.id}/consent`, { token: a.token, body: { event: "granted", evidence: "Casilla marcada en el formulario web", occurredAt: new Date(Date.now() - 60_000).toISOString() } });
      const d = (await api.call("POST", "/message-drafts", { token: a.token, body: { contactId: c.id, channel: "email", subject: "Una idea para su equipo", body: "Hola, le comparto una propuesta breve.", evidenceRefs: [] } })).body as { id: string };
      return { contactId: c.id, draftId: d.id, address: `compras@${domain}` };
    };
    const one = await mk();
    const send = (t: string, id: string) => api.call("POST", `/message-drafts/${id}/send`, { token: t });
    expect((await send(a.token, one.draftId)).status).toBe(409); // pending review: not sendable
    await api.call("POST", `/message-drafts/${one.draftId}/approve`, { token: a.token });
    expect((await api.call("GET", `/message-drafts/${one.draftId}/delivery`, { token: a.token })).body).toMatchObject({ state: "none" });
    expect((await send(b.token, one.draftId)).status).toBe(404); // another organization cannot see it
    expect((await send(await member(a.orgId, "campaign_manager"), one.draftId)).status).toBe(403);
    expect((await send(a.token, one.draftId)).body).toMatchObject({ state: "queued" });
    expect((await send(a.token, one.draftId)).status).toBe(409); // already queued
    expect(received).toHaveLength(0); // the request sent nothing

    // a second draft whose contact withdraws consent after the approval
    const two = await mk();
    await api.call("POST", `/message-drafts/${two.draftId}/approve`, { token: a.token });
    await send(a.token, two.draftId);
    await api.call("POST", `/contacts/${two.contactId}/consent`, { token: a.token, body: { event: "withdrawn", evidence: "Baja por telefono", occurredAt: new Date(Date.now() - 1000).toISOString() } });

    const deliveries = api.app.get(DraftDeliveryService);
    expect(await deliveries.sendQueued(workerCtx(b), 50)).toMatchObject({ processed: 0, noProvider: true }); // B has nothing and no provider
    expect(await deliveries.sendQueued(workerCtx(a), 50)).toMatchObject({ processed: 2, sent: 1, skipped: 1, failed: 0 });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ to: [one.address] });
    expect(received[0]?.data).toContain("Subject: Una idea para su equipo");
    expect(received[0]?.data).toMatch(/unsubscribe\?/);
    expect((await api.call("GET", `/message-drafts/${one.draftId}/delivery`, { token: a.token })).body).toMatchObject({ state: "sent", provider: "smtp" });
    expect((await api.call("GET", `/message-drafts/${two.draftId}/delivery`, { token: a.token })).body).toMatchObject({ state: "skipped" });
    expect(await deliveries.sendQueued(workerCtx(a), 50)).toMatchObject({ processed: 0 }); // idempotent: nothing is sent twice
    expect((await send(a.token, one.draftId)).status).toBe(409); // already sent
    expect(received).toHaveLength(1);
    expect(await asRuntime({ organizationId: b.orgId, role: "org_admin" }, async (c) => (await c.query("SELECT count(*)::int AS n FROM draft_deliveries")).rows[0].n)).toBe(0);
  });

  it("marks the attempt failed when the server rejects the login", async () => {
    const a = await register("smtp-send-fail");
    await put(a.token, settings({ password: "wrong-password" }));
    const c = await campaignWithContact(a.token);
    expect(await workerDispatch(a, c.id)).toMatchObject({ sent: 0, failed: 1 });
    expect(received).toHaveLength(0);
  });
});

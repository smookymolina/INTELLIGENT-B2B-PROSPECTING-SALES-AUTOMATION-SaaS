import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Tx } from "../db/prisma.service.js";
import { EmailSettingsService } from "../email-settings/email-settings.service.js";
import { SmtpEmailAdapter } from "../email-settings/smtp.js";
import { loadEmailCapConfig } from "../config/email.config.js";
import { ApiException } from "../http/api-exception.js";

export type OutboundEmail = Readonly<{ idempotencyKey: string; to: string; subject: string; body: string; unsubscribeUrl?: string }>;

/**
 * One email provider behind one shape. Real adapters (SES, Resend, Gmail...) need a verified sender domain, signed webhooks and a legal review,
 * and must send through a transactional outbox: `send` has to be idempotent on `idempotencyKey` because a retry can follow a crash after the call.
 */
export interface EmailAdapter {
  readonly name: string;
  send(email: OutboundEmail): Promise<{ messageId: string }>;
}

/** In-memory adapter for development and tests (EMAIL_PROVIDER=sandbox): nothing leaves the process, same key => same message id, no duplicate. */
export class SandboxEmailAdapter implements EmailAdapter {
  readonly name = "sandbox";
  readonly outbox: Array<OutboundEmail & { messageId: string }> = [];

  async send(email: OutboundEmail): Promise<{ messageId: string }> {
    const messageId = `sbx_${createHash("sha256").update(email.idempotencyKey).digest("hex").slice(0, 16)}`;
    if (!this.outbox.some((m) => m.messageId === messageId)) this.outbox.push({ ...email, messageId });
    return { messageId };
  }
}

/**
 * Transaction timeout for the transactions that SEND (campaign dispatch, draft delivery, sequence step): the SMTP round trip happens inside
 * them, and a transaction that dies after the server accepted the message would put the row back and resend it. Must stay above the SMTP
 * adapter's own overall deadline (SMTP_SEND_DEADLINE_MS in email-settings/smtp.ts).
 */
export const SEND_TX_TIMEOUT_MS = 60_000;

/** The organization's hourly or daily send cap is used up. Not a failure: the caller leaves the email pending and a later run sends it. */
export class EmailSendCapReached extends ApiException {
  constructor(readonly window: "hour" | "day", readonly limit: number) {
    super(429, "RATE_LIMITED", `The organization's email ${window === "hour" ? "hourly" : "daily"} limit (${limit}) is reached; sending resumes later`, { window, limit });
  }
}

/** The provider is read from EMAIL_PROVIDER at call time. Without one, dispatching is a clean 503: a campaign never "sends" into the void. */
@Injectable()
export class EmailChannels {
  readonly sandbox = new SandboxEmailAdapter();
  private readonly known = new Map<string, EmailAdapter>([["sandbox", this.sandbox]]);

  constructor(@Inject(EmailSettingsService) private readonly settings: EmailSettingsService) {}

  /**
   * The organization's own SMTP account wins; otherwise the process-wide provider (sandbox in development and tests); otherwise 503.
   * Then the per-organization cap (EMAIL_MAX_PER_HOUR / EMAIL_MAX_PER_DAY, rolling windows over every path that sends: campaigns, drafts,
   * sequences) is checked and EmailSendCapReached is thrown when it is used up. Call it inside the transaction that sends: it takes a
   * per-organization advisory lock held until that transaction ends, so concurrent senders of one organization are serialized and the
   * count always includes the sends committed before (no overshoot).
   */
  async forTenant(tx: Tx, organizationId: string, options: { sandboxOutsideProduction?: boolean } = {}, env: NodeJS.ProcessEnv = process.env): Promise<EmailAdapter> {
    const adapter = await this.resolve(tx, organizationId, options, env);
    await this.assertWithinCap(tx, organizationId, env);
    return adapter;
  }

  /** Which provider applies, WITHOUT the cap or its lock: only to decide whether to send at all. Never send with it; send with `forTenant`. */
  async resolve(tx: Tx, organizationId: string, options: { sandboxOutsideProduction?: boolean } = {}, env: NodeJS.ProcessEnv = process.env): Promise<EmailAdapter> {
    const account = await this.settings.account(tx, organizationId);
    if (account) return new SmtpEmailAdapter(account, env);
    // Sequences historically ran on the sandbox without EMAIL_PROVIDER; that shortcut is kept for development and tests only.
    if (options.sandboxOutsideProduction && !env.EMAIL_PROVIDER && env.NODE_ENV !== "production") return this.sandbox;
    return this.current(env);
  }

  private async assertWithinCap(tx: Tx, organizationId: string, env: NodeJS.ProcessEnv): Promise<void> {
    const cap = loadEmailCapConfig(env);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`email_cap:${organizationId}`}, 0))`;
    // No upper bound on the window: a row stamped by a clock slightly ahead still counts.
    const [row] = await tx.$queryRaw<Array<{ hour: bigint; day: bigint }>>`
      WITH sent AS (
        SELECT attempted_at AS at FROM send_attempts WHERE organization_id = ${organizationId}::uuid AND state = 'sent' AND attempted_at >= now() - interval '24 hours'
        UNION ALL
        SELECT attempted_at FROM draft_deliveries WHERE organization_id = ${organizationId}::uuid AND state = 'sent' AND attempted_at >= now() - interval '24 hours'
        UNION ALL
        SELECT sent_at FROM sequence_deliveries WHERE organization_id = ${organizationId}::uuid AND sent_at >= now() - interval '24 hours'
      )
      SELECT count(*) FILTER (WHERE at >= now() - interval '1 hour') AS hour, count(*) AS day FROM sent`;
    if (Number(row?.hour ?? 0) >= cap.maxPerHour) throw new EmailSendCapReached("hour", cap.maxPerHour);
    if (Number(row?.day ?? 0) >= cap.maxPerDay) throw new EmailSendCapReached("day", cap.maxPerDay);
  }

  register(adapter: EmailAdapter): void {
    this.known.set(adapter.name, adapter);
  }

  current(env: NodeJS.ProcessEnv = process.env): EmailAdapter {
    const adapter = env.EMAIL_PROVIDER ? this.known.get(env.EMAIL_PROVIDER) : undefined;
    if (!adapter) throw new ApiException(503, "UNAVAILABLE", "No email provider is configured");
    return adapter;
  }
}

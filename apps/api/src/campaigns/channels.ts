import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Tx } from "../db/prisma.service.js";
import { EmailSettingsService } from "../email-settings/email-settings.service.js";
import { SmtpEmailAdapter } from "../email-settings/smtp.js";
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

/** The provider is read from EMAIL_PROVIDER at call time. Without one, dispatching is a clean 503: a campaign never "sends" into the void. */
@Injectable()
export class EmailChannels {
  readonly sandbox = new SandboxEmailAdapter();
  private readonly known = new Map<string, EmailAdapter>([["sandbox", this.sandbox]]);

  constructor(@Inject(EmailSettingsService) private readonly settings: EmailSettingsService) {}

  /** The organization's own SMTP account wins; otherwise the process-wide provider (sandbox in development and tests); otherwise 503. */
  async forTenant(tx: Tx, organizationId: string, options: { sandboxOutsideProduction?: boolean } = {}, env: NodeJS.ProcessEnv = process.env): Promise<EmailAdapter> {
    const account = await this.settings.account(tx, organizationId);
    if (account) return new SmtpEmailAdapter(account, env);
    // Sequences historically ran on the sandbox without EMAIL_PROVIDER; that shortcut is kept for development and tests only.
    if (options.sandboxOutsideProduction && !env.EMAIL_PROVIDER && env.NODE_ENV !== "production") return this.sandbox;
    return this.current(env);
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

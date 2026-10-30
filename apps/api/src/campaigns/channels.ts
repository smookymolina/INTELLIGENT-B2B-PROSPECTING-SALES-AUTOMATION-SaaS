import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ApiException } from "../http/api-exception.js";

export type OutboundEmail = Readonly<{ idempotencyKey: string; to: string; subject: string; body: string }>;

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

  register(adapter: EmailAdapter): void {
    this.known.set(adapter.name, adapter);
  }

  current(env: NodeJS.ProcessEnv = process.env): EmailAdapter {
    const adapter = env.EMAIL_PROVIDER ? this.known.get(env.EMAIL_PROVIDER) : undefined;
    if (!adapter) throw new ApiException(503, "UNAVAILABLE", "No email provider is configured");
    return adapter;
  }
}

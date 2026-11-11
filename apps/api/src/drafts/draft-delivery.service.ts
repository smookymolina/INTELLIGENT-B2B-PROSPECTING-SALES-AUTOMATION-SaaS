import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { DraftDeliveryDto } from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { EmailChannels, type EmailAdapter } from "../campaigns/channels.js";
import { evaluateContacts, unsubscribeUrl } from "../campaigns/eligibility.js";
import { PrismaService, type Tx } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";
import { ProspectsService } from "../prospects/prospects.service.js";

type Row = { draft_id: string; state: string; skip_reason: string | null; provider: string | null; attempted_at: Date | null };
const toDto = (r: Row): DraftDeliveryDto => ({ draftId: r.draft_id, state: r.state as DraftDeliveryDto["state"], skipReason: r.skip_reason, provider: r.provider, attemptedAt: r.attempted_at?.toISOString() ?? null });
const conflict = (message: string) => new ApiException(409, "CONFLICT", message);
const NIL_CAMPAIGN = { id: "00000000-0000-0000-0000-000000000000", min_days_between: 0 };
export type DraftSendResult = { processed: number; sent: number; failed: number; skipped: number; noProvider: boolean };

/**
 * Sending an approved email draft takes two human decisions (approve, then send) and one machine step: the request only queues a delivery; the
 * worker sends it with the organization's own mailbox after re-checking consent, opt-out and suppression at that moment.
 */
@Injectable()
export class DraftDeliveryService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ProspectsService) private readonly prospects: ProspectsService,
    @Inject(EmailChannels) private readonly channels: EmailChannels,
  ) {}

  private async draft(tx: Tx, auth: AuthContext, id: string) {
    const d = await tx.messageDraft.findFirst({ where: { id, organization_id: auth.organizationId } });
    if (!d) throw new NotFoundException();
    return d;
  }

  get(auth: AuthContext, draftId: string): Promise<DraftDeliveryDto> {
    return this.db.withTenant(auth, async (tx) => {
      await this.draft(tx, auth, draftId);
      const row = await tx.draftDelivery.findFirst({ where: { organization_id: auth.organizationId, draft_id: draftId } });
      return row ? toDto(row) : { draftId, state: "none", skipReason: null, provider: null, attemptedAt: null };
    });
  }

  /** Queues the delivery. A failed or skipped one can be queued again; a queued or sent one cannot. */
  queue(auth: AuthContext, draftId: string): Promise<DraftDeliveryDto> {
    return this.db.withTenant(auth, async (tx) => {
      const d = await this.draft(tx, auth, draftId);
      if (d.channel !== "email") throw conflict("Only email drafts can be sent");
      if (d.status !== "approved") throw conflict("Only an approved draft can be sent");
      const existing = await tx.draftDelivery.findFirst({ where: { organization_id: auth.organizationId, draft_id: draftId } });
      if (existing && (existing.state === "queued" || existing.state === "sent")) throw conflict(existing.state === "sent" ? "That draft was already sent" : "That draft is already queued");
      const row = existing
        ? await tx.draftDelivery.update({ where: { id: existing.id }, data: { state: "queued", skip_reason: null, provider: null, attempted_at: null } })
        : await tx.draftDelivery.create({ data: { organization_id: auth.organizationId, draft_id: draftId, contact_id: d.contact_id, requested_by: auth.userId } });
      await this.audit.record(tx, auth, { action: "draft.send_queued", resourceType: "message_draft", resourceId: draftId });
      return toDto(row);
    });
  }

  /** Worker only. Each delivery is its own transaction; without a provider everything stays queued. */
  async sendQueued(auth: AuthContext, limit: number, now: Date = new Date()): Promise<DraftSendResult> {
    const out: DraftSendResult = { processed: 0, sent: 0, failed: 0, skipped: 0, noProvider: false };
    let adapter: EmailAdapter;
    try {
      adapter = await this.db.withTenant(auth, (tx) => this.channels.forTenant(tx, auth.organizationId));
    } catch (e) {
      if (e instanceof ApiException && e.getStatus() === 503) return { ...out, noProvider: true };
      throw e;
    }
    const queued = await this.db.withTenant(auth, (tx) => tx.draftDelivery.findMany({ where: { organization_id: auth.organizationId, state: "queued" }, orderBy: { created_at: "asc" }, take: limit, select: { id: true } }));
    for (const q of queued) {
      const outcome = await this.db.withTenant(auth, async (tx): Promise<"sent" | "failed" | "skipped" | "gone"> => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM draft_deliveries WHERE id = ${q.id}::uuid AND state = 'queued' FOR UPDATE SKIP LOCKED`;
        if (locked.length === 0) return "gone";
        const delivery = await tx.draftDelivery.findFirstOrThrow({ where: { id: q.id, organization_id: auth.organizationId } });
        const d = await tx.messageDraft.findFirstOrThrow({ where: { id: delivery.draft_id, organization_id: auth.organizationId } });
        // Consent, opt-out and suppression are checked again NOW: they may have changed since the approval.
        const verdicts = await evaluateContacts(tx, auth.organizationId, NIL_CAMPAIGN, await this.prospects.suppressionSets(tx, auth), { contactIds: [delivery.contact_id], ignoreOwnAttempts: true, channel: "email" });
        const found = verdicts.get(delivery.contact_id);
        const reason = found === undefined ? "no_consent" : found;
        if (reason !== null || d.status !== "approved") {
          await tx.draftDelivery.update({ where: { id: q.id }, data: { state: "skipped", skip_reason: reason ?? "not_approved", attempted_at: now } });
          return "skipped";
        }
        const contact = await tx.contact.findFirstOrThrow({ where: { id: delivery.contact_id, organization_id: auth.organizationId } });
        const unsubscribe = unsubscribeUrl(auth.organizationId, contact.id);
        try {
          const { messageId } = await adapter.send({ idempotencyKey: `draft:${delivery.id}`, to: contact.address, subject: d.subject ?? "", body: `${d.body}\n\nPara dejar de recibir estos mensajes: ${unsubscribe}`, unsubscribeUrl: unsubscribe });
          await tx.draftDelivery.update({ where: { id: q.id }, data: { state: "sent", provider: adapter.name, provider_message_id: messageId, attempted_at: now } });
          await this.audit.record(tx, auth, { action: "draft.sent", resourceType: "message_draft", resourceId: d.id, metadata: { provider: adapter.name } });
          return "sent";
        } catch (e) {
          if (e instanceof ApiException) throw e;
          await tx.draftDelivery.update({ where: { id: q.id }, data: { state: "failed", provider: adapter.name, attempted_at: now } });
          return "failed";
        }
      });
      if (outcome === "gone") continue;
      out.processed += 1;
      out[outcome] += 1;
    }
    return out;
  }
}

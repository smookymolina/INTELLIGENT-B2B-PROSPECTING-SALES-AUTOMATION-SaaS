import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  EXCLUSION_REASONS,
  type AttemptListQuery,
  type AttemptPageDto,
  type AudiencePreviewDto,
  type CampaignDto,
  type CampaignListQuery,
  type CampaignPageDto,
  type CreateCampaignRequest,
  type DispatchResultDto,
  type UnsubscribeRequest,
  type UpdateCampaignRequest,
} from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService, type Tx } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";
import { ProspectsService } from "../prospects/prospects.service.js";
import { EmailChannels } from "./channels.js";
import { evaluateContacts, render, unsubscribeUrl, validUnsubscribeSignature, type ExclusionReason } from "./eligibility.js";

const conflict = (message: string) => new ApiException(409, "CONFLICT", message);
const dbMessage = (e: unknown) => String((e as { message?: string }).message ?? "");

function mapDbError(e: unknown): never {
  const m = dbMessage(e);
  if (m.includes("invalid campaign transition")) throw conflict("That change is not allowed from the campaign's current state");
  if (m.includes("only a draft campaign can be edited")) throw conflict("Only a draft campaign can be edited");
  if (m.includes("cannot approve campaigns") || m.includes("row-level security") || m.includes("insufficient_privilege")) throw new ApiException(403, "FORBIDDEN", "Not allowed");
  if (m.includes("no consent") || m.includes("do-not-contact")) throw conflict("The contact can no longer be emailed");
  throw e;
}

type CampaignRow = {
  id: string; name: string; subject: string; body: string; state: string; min_days_between: number; created_by: string; approved_at: Date | null; launched_at: Date | null; created_at: Date;
};
const emptyCounts = () => ({ queued: 0, sent: 0, skipped: 0, failed: 0, cancelled: 0 });
const toDto = (r: CampaignRow, counts = emptyCounts()): CampaignDto => ({
  id: r.id, name: r.name, subject: r.subject, body: r.body, state: r.state as CampaignDto["state"], minDaysBetween: r.min_days_between, createdBy: r.created_by,
  approvedAt: r.approved_at?.toISOString() ?? null, launchedAt: r.launched_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(), attempts: counts,
});

/**
 * One-email campaigns: draft -> approved -> running (-> paused) -> completed. Audience = every email contact that is currently eligible; the
 * eligibility rules (consent, opt-out, suppression, frequency) are evaluated for the preview, at launch and again for EACH send.
 * The email adapter is a sandbox until a real provider is approved (docs/modules/EMAIL_AUTOMATION.md).
 */
@Injectable()
export class CampaignsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ProspectsService) private readonly prospects: ProspectsService,
    @Inject(EmailChannels) private readonly channels: EmailChannels,
  ) {}

  /* ---------- CRUD ---------- */

  create(auth: AuthContext, input: CreateCampaignRequest): Promise<CampaignDto> {
    return this.db.withTenant(auth, async (tx) => {
      const row = await tx.campaign.create({ data: { organization_id: auth.organizationId, name: input.name, subject: input.subject, body: input.body, min_days_between: input.minDaysBetween, created_by: auth.userId } });
      await this.audit.record(tx, auth, { action: "campaign.created", resourceType: "campaign", resourceId: row.id });
      return toDto(row);
    });
  }

  list(auth: AuthContext, q: CampaignListQuery): Promise<CampaignPageDto> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.campaign.findMany({
        where: { organization_id: auth.organizationId, ...(q.state !== "all" ? { state: q.state } : {}), ...(q.cursor ? { id: { gt: q.cursor } } : {}) },
        orderBy: { id: "asc" },
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const counts = await this.counts(tx, auth, page.map((r) => r.id));
      return { items: page.map((r) => toDto(r, counts.get(r.id))), nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
    });
  }

  get(auth: AuthContext, id: string): Promise<CampaignDto> {
    return this.db.withTenant(auth, (tx) => this.dto(tx, auth, id));
  }

  update(auth: AuthContext, id: string, input: UpdateCampaignRequest): Promise<CampaignDto> {
    return this.db
      .withTenant(auth, async (tx) => {
        await this.require(tx, auth, id);
        await tx.campaign.update({
          where: { id },
          data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.subject !== undefined ? { subject: input.subject } : {}), ...(input.body !== undefined ? { body: input.body } : {}), ...(input.minDaysBetween !== undefined ? { min_days_between: input.minDaysBetween } : {}) },
        });
        await this.audit.record(tx, auth, { action: "campaign.updated", resourceType: "campaign", resourceId: id });
        return this.dto(tx, auth, id);
      })
      .catch(mapDbError);
  }

  /* ---------- state machine (the database enforces the transitions and stamps the approver) ---------- */

  approve(auth: AuthContext, id: string): Promise<CampaignDto> {
    return this.transition(auth, id, "draft", "approved", "campaign.approved");
  }
  pause(auth: AuthContext, id: string): Promise<CampaignDto> {
    return this.transition(auth, id, "running", "paused", "campaign.paused");
  }
  /** The state machine also allows approved -> running (that is launching, which queues the audience); resuming only applies to a paused campaign. */
  resume(auth: AuthContext, id: string): Promise<CampaignDto> {
    return this.transition(auth, id, "paused", "running", "campaign.resumed");
  }

  cancel(auth: AuthContext, id: string): Promise<CampaignDto> {
    return this.db
      .withTenant(auth, async (tx) => {
        const current = await this.require(tx, auth, id);
        if (current.state === "cancelled" || current.state === "completed") throw conflict("The campaign is already closed");
        await tx.campaign.update({ where: { id }, data: { state: "cancelled" } });
        const res = await tx.sendAttempt.updateMany({ where: { campaign_id: id, organization_id: auth.organizationId, state: "queued" }, data: { state: "cancelled" } });
        await this.audit.record(tx, auth, { action: "campaign.cancelled", resourceType: "campaign", resourceId: id, metadata: { cancelledAttempts: res.count } });
        return this.dto(tx, auth, id);
      })
      .catch(mapDbError);
  }

  /* ---------- audience, launch, dispatch ---------- */

  preview(auth: AuthContext, id: string): Promise<AudiencePreviewDto> {
    return this.db.withTenant(auth, async (tx) => {
      const c = await this.require(tx, auth, id);
      const verdicts = await evaluateContacts(tx, auth.organizationId, c, await this.prospects.suppressionSets(tx, auth));
      const excluded = Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, 0])) as AudiencePreviewDto["excluded"];
      let eligible = 0;
      for (const v of verdicts.values()) {
        if (v === null) eligible += 1;
        else excluded[v] += 1;
      }
      return { total: verdicts.size, eligible, excluded };
    });
  }

  /** Queues one attempt per eligible contact. The (campaign, contact) pair is unique, so a repeated launch can never queue anybody twice. */
  launch(auth: AuthContext, id: string): Promise<CampaignDto> {
    return this.db
      .withTenant(auth, async (tx) => {
        const c = await this.require(tx, auth, id);
        if (c.state !== "approved") throw conflict("Only an approved campaign can be launched");
        await tx.campaign.update({ where: { id }, data: { state: "running" } });
        const verdicts = await evaluateContacts(tx, auth.organizationId, c, await this.prospects.suppressionSets(tx, auth));
        const eligible = [...verdicts].filter(([, v]) => v === null).map(([contactId]) => contactId);
        if (eligible.length > 0) await tx.sendAttempt.createMany({ data: eligible.map((contactId) => ({ organization_id: auth.organizationId, campaign_id: id, contact_id: contactId })), skipDuplicates: true });
        await this.audit.record(tx, auth, { action: "campaign.launched", resourceType: "campaign", resourceId: id, metadata: { queued: eligible.length } });
        return this.dto(tx, auth, id);
      })
      .catch(mapDbError);
  }

  async dispatch(auth: AuthContext, id: string, limit: number, opts: { worker?: boolean } = {}): Promise<DispatchResultDto> {
    const adapter = await this.db.withTenant(auth, (tx) => this.channels.forTenant(tx, auth.organizationId)); // 503 when no provider is configured
    // Real mail never leaves inside an HTTP request: with a real provider only the worker dispatches (it picks the campaign up by itself).
    if (!opts.worker && adapter.name !== "sandbox") throw conflict("This organization sends real email: the worker dispatches running campaigns automatically");
    const first = await this.db.withTenant(auth, (tx) => this.require(tx, auth, id));
    if (first.state !== "running") throw conflict("Only a running campaign dispatches");
    const queued = await this.db.withTenant(auth, (tx) => tx.sendAttempt.findMany({ where: { campaign_id: id, organization_id: auth.organizationId, state: "queued" }, orderBy: { created_at: "asc" }, take: limit, select: { id: true, contact_id: true } }));
    const out = { processed: 0, sent: 0, failed: 0, skipped: {} as Record<string, number> };
    for (const attempt of queued) {
      const outcome = await this.db
        .withTenant(auth, async (tx): Promise<"sent" | "failed" | "gone" | "paused" | ExclusionReason> => {
          const c = await this.require(tx, auth, id);
          if (c.state !== "running") return "paused"; // paused/cancelled while we were working: stop, nothing else is touched
          const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM send_attempts WHERE id = ${attempt.id}::uuid AND state = 'queued' FOR UPDATE SKIP LOCKED`;
          if (locked.length === 0) return "gone"; // another dispatcher owns it or it already finished
          // Re-check EVERYTHING now: consent, opt-out, suppression and frequency may have changed since the launch.
          const verdicts = await evaluateContacts(tx, auth.organizationId, c, await this.prospects.suppressionSets(tx, auth), { contactIds: [attempt.contact_id], ignoreOwnAttempts: true });
          const found = verdicts.get(attempt.contact_id);
          const verdict: ExclusionReason | null = found === undefined ? "no_consent" : found; // null means eligible; a contact that vanished is never sent to
          if (verdict !== null) {
            await tx.sendAttempt.update({ where: { id: attempt.id }, data: { state: "skipped", skip_reason: verdict } });
            return verdict;
          }
          const contact = await tx.contact.findFirstOrThrow({ where: { id: attempt.contact_id, organization_id: auth.organizationId }, include: { prospect: { select: { name: true } } } });
          const vars = { company: contact.prospect.name, unsubscribe_url: unsubscribeUrl(auth.organizationId, contact.id) };
          try {
            const { messageId } = await adapter.send({ idempotencyKey: attempt.id, to: contact.address, subject: render(c.subject, vars), body: render(c.body, vars), unsubscribeUrl: vars.unsubscribe_url });
            await tx.sendAttempt.update({ where: { id: attempt.id }, data: { state: "sent", provider: adapter.name, provider_message_id: messageId } });
            return "sent";
          } catch (e) {
            if (e instanceof ApiException || dbMessage(e).includes("no consent")) throw e;
            await tx.sendAttempt.update({ where: { id: attempt.id }, data: { state: "failed" } });
            return "failed";
          }
        })
        .catch(mapDbError);
      if (outcome === "paused") break;
      if (outcome === "gone") continue;
      out.processed += 1;
      if (outcome === "sent") out.sent += 1;
      else if (outcome === "failed") out.failed += 1;
      else out.skipped[outcome] = (out.skipped[outcome] ?? 0) + 1;
    }
    return this.db.withTenant(auth, async (tx) => {
      const remaining = await tx.sendAttempt.count({ where: { campaign_id: id, organization_id: auth.organizationId, state: "queued" } });
      let c = await this.require(tx, auth, id);
      if (remaining === 0 && c.state === "running") {
        await tx.campaign.update({ where: { id }, data: { state: "completed" } });
        c = await this.require(tx, auth, id);
      }
      await this.audit.record(tx, auth, { action: "campaign.dispatched", resourceType: "campaign", resourceId: id, metadata: { processed: out.processed, sent: out.sent, failed: out.failed, skipped: out.skipped } });
      return { ...out, remainingQueued: remaining, campaignState: c.state as DispatchResultDto["campaignState"] };
    });
  }

  attempts(auth: AuthContext, id: string, q: AttemptListQuery): Promise<AttemptPageDto> {
    return this.db.withTenant(auth, async (tx) => {
      await this.require(tx, auth, id);
      const rows = await tx.sendAttempt.findMany({
        where: { campaign_id: id, organization_id: auth.organizationId, ...(q.state !== "all" ? { state: q.state } : {}), ...(q.cursor ? { id: { gt: q.cursor } } : {}) },
        orderBy: { id: "asc" },
        take: q.limit + 1,
        include: { contact: { select: { address: true } } },
      });
      const page = rows.slice(0, q.limit);
      return {
        items: page.map((r) => ({ id: r.id, contactId: r.contact_id, address: r.contact.address, state: r.state as AttemptPageDto["items"][number]["state"], skipReason: r.skip_reason, providerMessageId: r.provider_message_id, attemptedAt: r.attempted_at?.toISOString() ?? null })),
        nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    });
  }

  /** Public, pre-tenant. A bad signature and an unknown contact are answered exactly like success: the endpoint is not an oracle. */
  async unsubscribe(input: UnsubscribeRequest): Promise<void> {
    if (!validUnsubscribeSignature(input.org, input.contact, input.sig)) return;
    await this.db.withoutTenant((tx) => tx.$queryRaw`SELECT public_unsubscribe(${input.org}::uuid, ${input.contact}::uuid)`);
  }

  /* ---------- internals ---------- */

  private async require(tx: Tx, auth: AuthContext, id: string) {
    const row = await tx.campaign.findFirst({ where: { id, organization_id: auth.organizationId } });
    if (!row) throw new NotFoundException();
    return row;
  }

  private async counts(tx: Tx, auth: AuthContext, ids: string[]) {
    const out = new Map<string, ReturnType<typeof emptyCounts>>();
    if (ids.length === 0) return out;
    const groups = await tx.sendAttempt.groupBy({ by: ["campaign_id", "state"], where: { organization_id: auth.organizationId, campaign_id: { in: ids } }, _count: { _all: true } });
    for (const g of groups) {
      const c = out.get(g.campaign_id) ?? emptyCounts();
      c[g.state as keyof typeof c] = g._count._all;
      out.set(g.campaign_id, c);
    }
    return out;
  }

  private async dto(tx: Tx, auth: AuthContext, id: string): Promise<CampaignDto> {
    const row = await this.require(tx, auth, id);
    return toDto(row, (await this.counts(tx, auth, [id])).get(id));
  }

  /** Same-state "transitions" are not state changes for the trigger, so the expected origin is checked here: repeating a request is a 409, not a silent success. */
  private transition(auth: AuthContext, id: string, from: string, state: "approved" | "paused" | "running", action: string): Promise<CampaignDto> {
    return this.db
      .withTenant(auth, async (tx) => {
        const current = await this.require(tx, auth, id);
        if (current.state !== from) throw conflict(`That change needs the campaign to be ${from}`);
        await tx.campaign.update({ where: { id }, data: { state } });
        await this.audit.record(tx, auth, { action, resourceType: "campaign", resourceId: id });
        return this.dto(tx, auth, id);
      })
      .catch(mapDbError);
  }
}

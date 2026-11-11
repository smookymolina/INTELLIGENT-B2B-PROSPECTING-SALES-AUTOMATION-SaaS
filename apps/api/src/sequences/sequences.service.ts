import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  EXCLUSION_REASONS,
  type EnrollmentListQuery,
  type EnrollmentPageDto,
  type EnrollResultDto,
  type RunDueResultDto,
  type SaveSequenceRequest,
  type SequenceDto,
} from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { EmailChannels } from "../campaigns/channels.js";
import { evaluateContacts, render, unsubscribeUrl, type ExclusionReason } from "../campaigns/eligibility.js";
import { PrismaService, type Tx } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";
import { ProspectsService } from "../prospects/prospects.service.js";
import { fromMinutes, insideWindow, nextAllowed, toMinutes, type Window } from "./schedule.js";

const conflict = (message: string) => new ApiException(409, "CONFLICT", message);
const HOUR = 3_600_000;

function mapDbError(e: unknown): never {
  const m = String((e as { message?: string }).message ?? "");
  if (m.includes("only a draft campaign can change its sequence")) throw conflict("The sequence can only be changed while the campaign is a draft");
  if (m.includes("only a running campaign") || m.includes("has no sequence")) throw conflict("The campaign must be running and have a sequence");
  if (m.includes("no consent") || m.includes("do-not-contact")) throw conflict("The contact can no longer be emailed");
  if (m.includes("row-level security") || m.includes("insufficient_privilege")) throw new ApiException(403, "FORBIDDEN", "Not allowed");
  throw e;
}

/**
 * Multi-step email sequences on the sandbox channel ONLY. Nothing sends by itself: the worker calls `runDue`, which sends a step only when the
 * campaign is running (= approved and launched), the contact is still eligible (consent, opt-out, suppression, frequency cap re-checked for
 * every step) and "now" is inside the campaign's window; otherwise the step is deferred to the next window or the enrolment is stopped.
 */
@Injectable()
export class SequencesService {
  /** Replaceable clock (tests, and a future worker with its own time source). */
  now: () => Date = () => new Date();

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ProspectsService) private readonly prospects: ProspectsService,
    @Inject(EmailChannels) private readonly channels: EmailChannels,
  ) {}

  get(auth: AuthContext, campaignId: string): Promise<SequenceDto> {
    return this.db.withTenant(auth, async (tx) => {
      await this.campaign(tx, auth, campaignId);
      return this.dto(tx, auth, campaignId);
    });
  }

  save(auth: AuthContext, campaignId: string, input: SaveSequenceRequest): Promise<SequenceDto> {
    return this.db
      .withTenant(auth, async (tx) => {
        const c = await this.campaign(tx, auth, campaignId);
        if (c.state !== "draft") throw conflict("The sequence can only be changed while the campaign is a draft");
        const org = auth.organizationId;
        await tx.sequenceStep.deleteMany({ where: { organization_id: org, campaign_id: campaignId } });
        const data = { timezone: input.timezone, window_start_min: toMinutes(input.windowStart), window_end_min: toMinutes(input.windowEnd), weekdays: [...input.weekdays].sort((a, b) => a - b) };
        const existing = await tx.campaignSchedule.findFirst({ where: { organization_id: org, campaign_id: campaignId }, select: { id: true } });
        if (existing) await tx.campaignSchedule.update({ where: { id: existing.id }, data });
        else await tx.campaignSchedule.create({ data: { ...data, organization_id: org, campaign_id: campaignId, created_by: auth.userId } });
        await tx.sequenceStep.createMany({ data: input.steps.map((s, i) => ({ organization_id: org, campaign_id: campaignId, step_no: i + 1, delay_hours: s.delayHours, subject: s.subject, body: s.body })) });
        await this.audit.record(tx, auth, { action: "sequence.saved", resourceType: "campaign", resourceId: campaignId, metadata: { steps: input.steps.length, timezone: input.timezone } });
        return this.dto(tx, auth, campaignId);
      })
      .catch(mapDbError);
  }

  /** Enrols every contact that is eligible right now. Idempotent: (campaign, contact) is unique, enrolled contacts are only counted. */
  enroll(auth: AuthContext, campaignId: string): Promise<EnrollResultDto> {
    return this.db
      .withTenant(auth, async (tx): Promise<EnrollResultDto> => {
        const c = await this.campaign(tx, auth, campaignId);
        if (c.state !== "running") throw conflict("Only a running (approved and launched) campaign enrols contacts");
        const win = await this.window(tx, auth, campaignId);
        if (!win || (await tx.sequenceStep.count({ where: { organization_id: auth.organizationId, campaign_id: campaignId } })) === 0) throw conflict("The campaign has no sequence");
        const verdicts = await evaluateContacts(tx, auth.organizationId, c, await this.prospects.suppressionSets(tx, auth), { ignoreOwnAttempts: true });
        const have = new Set((await tx.sequenceEnrollment.findMany({ where: { organization_id: auth.organizationId, campaign_id: campaignId }, select: { contact_id: true } })).map((e) => e.contact_id));
        const excluded = Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, 0])) as EnrollResultDto["excluded"];
        const fresh: string[] = [];
        let already = 0;
        for (const [contactId, v] of verdicts) {
          if (have.has(contactId)) already += 1;
          else if (v === null) fresh.push(contactId);
          else excluded[v] += 1;
        }
        const firstDue = nextAllowed(this.now(), win);
        if (fresh.length > 0) {
          await tx.sequenceEnrollment.createMany({ data: fresh.map((contact_id) => ({ organization_id: auth.organizationId, campaign_id: campaignId, contact_id, next_step: 1, next_due_at: firstDue, created_by: auth.userId })), skipDuplicates: true });
        }
        await this.audit.record(tx, auth, { action: "sequence.enrolled", resourceType: "campaign", resourceId: campaignId, metadata: { enrolled: fresh.length, excluded } });
        return { enrolled: fresh.length, alreadyEnrolled: already, excluded, firstDueAt: fresh.length > 0 ? firstDue.toISOString() : null };
      })
      .catch(mapDbError);
  }

  /** What the worker calls: processes at most `limit` enrolments whose next step is due. Each enrolment runs in its own transaction. */
  async runDue(auth: AuthContext, campaignId: string, limit: number): Promise<RunDueResultDto> {
    const now = this.now();
    const due = await this.db.withTenant(auth, async (tx) => {
      const c = await this.campaign(tx, auth, campaignId);
      if (c.state === "draft" || c.state === "approved") throw conflict("The campaign has not been launched");
      return tx.sequenceEnrollment.findMany({ where: { organization_id: auth.organizationId, campaign_id: campaignId, state: "active", next_due_at: { lte: now } }, orderBy: [{ next_due_at: "asc" }, { id: "asc" }], take: limit, select: { id: true } });
    });
    const out: RunDueResultDto = { processed: 0, sent: 0, deferred: 0, completed: 0, stopped: {}, nextDueAt: null };
    for (const { id } of due) {
      const r = await this.db.withTenant(auth, (tx) => this.step(tx, auth, campaignId, id, now)).catch(mapDbError);
      if (r === "gone" || r === "paused") continue;
      out.processed += 1;
      if (r === "sent" || r === "completed") out.sent += 1;
      if (r === "completed") out.completed += 1;
      else if (r === "deferred") out.deferred += 1;
      else if (r !== "sent") out.stopped[r] = (out.stopped[r] ?? 0) + 1;
    }
    return this.db.withTenant(auth, async (tx) => {
      const next = await tx.sequenceEnrollment.aggregate({ where: { organization_id: auth.organizationId, campaign_id: campaignId, state: "active" }, _min: { next_due_at: true } });
      await this.audit.record(tx, auth, { action: "sequence.run", resourceType: "campaign", resourceId: campaignId, metadata: { processed: out.processed, sent: out.sent, deferred: out.deferred, completed: out.completed, stopped: out.stopped } });
      return { ...out, nextDueAt: next._min.next_due_at?.toISOString() ?? null };
    });
  }

  enrollments(auth: AuthContext, campaignId: string, q: EnrollmentListQuery): Promise<EnrollmentPageDto> {
    return this.db.withTenant(auth, async (tx) => {
      await this.campaign(tx, auth, campaignId);
      const rows = await tx.sequenceEnrollment.findMany({
        where: { organization_id: auth.organizationId, campaign_id: campaignId, ...(q.state !== "all" ? { state: q.state } : {}), ...(q.cursor ? { id: { gt: q.cursor } } : {}) },
        orderBy: { id: "asc" },
        take: q.limit + 1,
        include: { contact: { select: { address: true } }, deliveries: { orderBy: { step_no: "asc" }, select: { step_no: true, provider_message_id: true, sent_at: true } } },
      });
      const page = rows.slice(0, q.limit);
      return {
        items: page.map((r) => ({
          id: r.id, contactId: r.contact_id, address: r.contact.address, state: r.state as EnrollmentPageDto["items"][number]["state"], stopReason: r.stop_reason, nextStep: r.next_step,
          nextDueAt: r.next_due_at?.toISOString() ?? null,
          deliveries: r.deliveries.map((d) => ({ stepNo: d.step_no, providerMessageId: d.provider_message_id, sentAt: d.sent_at.toISOString() })),
        })),
        nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    });
  }

  /* ---------- internals ---------- */

  private async step(tx: Tx, auth: AuthContext, campaignId: string, enrollmentId: string, now: Date): Promise<"sent" | "completed" | "deferred" | "gone" | "paused" | ExclusionReason | "campaign_closed"> {
    const org = auth.organizationId;
    const c = await this.campaign(tx, auth, campaignId);
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM sequence_enrollments WHERE id = ${enrollmentId}::uuid AND state = 'active' AND next_due_at <= ${now}::timestamptz FOR UPDATE SKIP LOCKED`;
    if (locked.length === 0) return "gone";
    const e = await tx.sequenceEnrollment.findFirstOrThrow({ where: { id: enrollmentId, organization_id: org } });
    if (c.state === "cancelled" || c.state === "completed") {
      await tx.sequenceEnrollment.update({ where: { id: e.id }, data: { state: "stopped", stop_reason: "campaign_closed", next_due_at: null } });
      return "campaign_closed";
    }
    if (c.state !== "running") return "paused"; // paused: nothing is touched, it resumes where it was
    // Re-check EVERYTHING now, for every step: consent, opt-out, suppression, frequency cap.
    const verdicts = await evaluateContacts(tx, org, c, await this.prospects.suppressionSets(tx, auth), { contactIds: [e.contact_id], ignoreOwnAttempts: true });
    const found = verdicts.get(e.contact_id);
    const verdict: ExclusionReason | null = found === undefined ? "no_consent" : found;
    if (verdict !== null) {
      await tx.sequenceEnrollment.update({ where: { id: e.id }, data: { state: "stopped", stop_reason: verdict, next_due_at: null } });
      return verdict;
    }
    const win = await this.window(tx, auth, campaignId);
    if (!win) throw conflict("The campaign has no sequence");
    if (!insideWindow(now, win)) {
      await tx.sequenceEnrollment.update({ where: { id: e.id }, data: { next_due_at: nextAllowed(now, win) } });
      return "deferred";
    }
    const steps = await tx.sequenceStep.findMany({ where: { organization_id: org, campaign_id: campaignId }, orderBy: { step_no: "asc" } });
    const current = steps.find((s) => s.step_no === e.next_step);
    if (!current) throw conflict("The campaign has no sequence");
    const contact = await tx.contact.findFirstOrThrow({ where: { id: e.contact_id, organization_id: org }, include: { prospect: { select: { name: true } } } });
    const vars = { company: contact.prospect.name, unsubscribe_url: unsubscribeUrl(org, contact.id) };
    // The organization's SMTP account when configured, else the process provider (503 without one). Idempotent on (enrolment, step).
    const adapter = await this.channels.forTenant(tx, org, { sandboxOutsideProduction: true });
    const { messageId } = await adapter.send({ idempotencyKey: `seq:${e.id}:${current.step_no}`, to: contact.address, subject: render(current.subject, vars), body: render(current.body, vars), unsubscribeUrl: vars.unsubscribe_url });
    await tx.sequenceDelivery.create({ data: { organization_id: org, enrollment_id: e.id, campaign_id: campaignId, contact_id: contact.id, step_no: current.step_no, provider: adapter.name, provider_message_id: messageId, sent_at: now } });
    const next = steps.find((s) => s.step_no === current.step_no + 1);
    if (!next) {
      await tx.sequenceEnrollment.update({ where: { id: e.id }, data: { state: "completed", next_due_at: null } });
      return "completed";
    }
    await tx.sequenceEnrollment.update({ where: { id: e.id }, data: { next_step: next.step_no, next_due_at: nextAllowed(new Date(now.getTime() + next.delay_hours * HOUR), win) } });
    return "sent";
  }

  private async campaign(tx: Tx, auth: AuthContext, id: string) {
    const row = await tx.campaign.findFirst({ where: { id, organization_id: auth.organizationId } });
    if (!row) throw new NotFoundException();
    return row;
  }

  private async window(tx: Tx, auth: AuthContext, campaignId: string): Promise<Window | null> {
    const s = await tx.campaignSchedule.findFirst({ where: { organization_id: auth.organizationId, campaign_id: campaignId } });
    return s ? { timezone: s.timezone, startMin: s.window_start_min, endMin: s.window_end_min, weekdays: s.weekdays } : null;
  }

  private async dto(tx: Tx, auth: AuthContext, campaignId: string): Promise<SequenceDto> {
    const [s, steps] = await Promise.all([
      tx.campaignSchedule.findFirst({ where: { organization_id: auth.organizationId, campaign_id: campaignId } }),
      tx.sequenceStep.findMany({ where: { organization_id: auth.organizationId, campaign_id: campaignId }, orderBy: { step_no: "asc" } }),
    ]);
    return {
      campaignId, configured: s !== null && steps.length > 0, timezone: s?.timezone ?? null,
      windowStart: s ? fromMinutes(s.window_start_min) : null, windowEnd: s ? fromMinutes(s.window_end_min) : null, weekdays: s?.weekdays ?? [],
      steps: steps.map((x) => ({ stepNo: x.step_no, delayHours: x.delay_hours, subject: x.subject, body: x.body })),
    };
  }
}

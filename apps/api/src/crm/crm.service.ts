import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  OPPORTUNITY_STAGES,
  type AddNoteRequest,
  type AssignRequest,
  type ChangeStageRequest,
  type CreateOpportunityRequest,
  type OpportunityDetailDto,
  type OpportunityDto,
  type OpportunityListQuery,
  type OpportunityPageDto,
  type PipelineSummaryDto,
  type PoolDto,
  type PoolMemberDto,
  type PoolMemberRequest,
  type RoutingSettingsDto,
  type RoutingSettingsRequest,
  type TimelineItemDto,
} from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService, type Prisma, type Tx } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";

const conflict = (message: string) => new ApiException(409, "CONFLICT", message);
const OPEN_EXCLUDED = ["won", "lost", "future"];
const dbMessage = (e: unknown) => String((e as { message?: string }).message ?? "");

type OppRow = {
  id: string; lead_id: string; prospect_id: string; title: string; stage: string; owner_user_id: string | null; assigned_at: Date | null;
  expected_value: { toFixed(n: number): string } | null; currency: string | null; loss_reason: string | null; first_response_due_at: Date | null;
  first_contacted_at: Date | null; closed_at: Date | null; created_at: Date;
};

const slaBreached = (o: OppRow, now = Date.now()): boolean | null => {
  if (!o.first_response_due_at) return null;
  const due = o.first_response_due_at.getTime();
  return o.first_contacted_at ? o.first_contacted_at.getTime() > due : now > due;
};

/** Mapped DB rule violations -> 409 with a stable, non-leaky message. */
function mapDbError(e: unknown): never {
  const m = dbMessage(e);
  if (m.includes("invalid stage transition")) throw conflict("That stage change is not allowed from the current stage");
  if (m.includes("closed opportunities are immutable")) throw conflict("The opportunity is closed");
  if (m.includes("owner must be an active")) throw conflict("The owner must be an active seller, sales manager or admin of this organization");
  if (m.includes("accepted lead")) throw conflict("Only an accepted lead can become an opportunity");
  if (m.includes("suppressed prospect")) throw conflict("The prospect is on the do-not-contact list");
  throw e;
}

/** Pipeline, timeline, notes, routing (manual / reproducible round-robin / queue) and SLA. Sellers only ever see their own opportunities (RLS). */
@Injectable()
export class CrmService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /* ---------- opportunities ---------- */

  list(auth: AuthContext, q: OpportunityListQuery): Promise<OpportunityPageDto> {
    return this.db.withTenant(auth, async (tx) => {
      const owner: string | null = q.owner === "me" ? auth.userId : q.owner === "unassigned" || q.owner === undefined ? null : q.owner;
      const rows = await tx.opportunity.findMany({
        where: {
          organization_id: auth.organizationId, ...(q.stage !== "all" ? { stage: q.stage } : {}), ...(q.owner !== undefined ? { owner_user_id: owner } : {}), ...(q.cursor ? { id: { gt: q.cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      return { items: await this.toDtos(tx, auth, page), nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
    });
  }

  summary(auth: AuthContext): Promise<PipelineSummaryDto> {
    return this.db.withTenant(auth, async (tx) => {
      const groups = await tx.opportunity.groupBy({ by: ["stage"], where: { organization_id: auth.organizationId }, _count: { _all: true } });
      const stages: Record<string, number> = Object.fromEntries(OPPORTUNITY_STAGES.map((s) => [s, 0]));
      for (const g of groups) stages[g.stage] = g._count._all;
      return { stages, total: groups.reduce((n, g) => n + g._count._all, 0) };
    });
  }

  async create(auth: AuthContext, input: CreateOpportunityRequest): Promise<OpportunityDto> {
    try {
      return await this.db.withTenant(auth, async (tx) => {
        const lead = await tx.lead.findFirst({ where: { id: input.leadId, organization_id: auth.organizationId } });
        if (!lead) throw new NotFoundException();
        if (lead.state !== "accepted") throw conflict("Only an accepted lead can become an opportunity");
        if (await tx.opportunity.findFirst({ where: { organization_id: auth.organizationId, lead_id: lead.id }, select: { id: true } })) throw conflict("That lead already has an opportunity");
        const row = await tx.opportunity.create({
          data: {
            organization_id: auth.organizationId, lead_id: lead.id, prospect_id: lead.prospect_id, title: input.title, created_by: auth.userId,
            expected_value: input.expectedValue ?? null, currency: input.currency ?? null,
          },
        });
        await this.audit.record(tx, auth, { action: "opportunity.created", resourceType: "opportunity", resourceId: row.id, metadata: { leadId: lead.id } });
        const settings = await tx.routingSettings.findUnique({ where: { organization_id: auth.organizationId } });
        if (settings?.strategy === "round_robin") await this.autoAssignTx(tx, auth, row.id);
        return (await this.toDtos(tx, auth, [await tx.opportunity.findFirstOrThrow({ where: { id: row.id } })]))[0] as OpportunityDto;
      });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw conflict("That lead already has an opportunity");
      return mapDbError(e);
    }
  }

  get(auth: AuthContext, id: string): Promise<OpportunityDetailDto> {
    return this.db.withTenant(auth, (tx) => this.detail(tx, auth, id));
  }

  changeStage(auth: AuthContext, id: string, input: ChangeStageRequest): Promise<OpportunityDto> {
    return this.db
      .withTenant(auth, async (tx) => {
        const current = await tx.opportunity.findFirst({ where: { id, organization_id: auth.organizationId } });
        if (!current) throw new NotFoundException();
        await tx.$executeRaw`SELECT set_config('app.stage_note', ${input.note ?? ""}, true)`; // read by the history trigger
        const row = await tx.opportunity.update({ where: { id }, data: { stage: input.stage, ...(input.stage === "lost" ? { loss_reason: input.lossReason ?? null } : {}) } });
        await this.audit.record(tx, auth, { action: "opportunity.stage_changed", resourceType: "opportunity", resourceId: id, metadata: { from: current.stage, to: input.stage } });
        return (await this.toDtos(tx, auth, [row]))[0] as OpportunityDto;
      })
      .catch(mapDbError);
  }

  addNote(auth: AuthContext, id: string, input: AddNoteRequest): Promise<OpportunityDetailDto> {
    return this.db.withTenant(auth, async (tx) => {
      if (!(await tx.opportunity.findFirst({ where: { id, organization_id: auth.organizationId }, select: { id: true } }))) throw new NotFoundException();
      await tx.opportunityNote.create({ data: { organization_id: auth.organizationId, opportunity_id: id, kind: input.kind, body: input.body, created_by: auth.userId } });
      await this.audit.record(tx, auth, { action: "opportunity.note_added", resourceType: "opportunity", resourceId: id, metadata: { kind: input.kind } });
      return this.detail(tx, auth, id);
    });
  }

  /* ---------- routing ---------- */

  assign(auth: AuthContext, id: string, input: AssignRequest): Promise<OpportunityDto> {
    return this.db
      .withTenant(auth, async (tx) => {
        await this.lockRouting(tx, auth);
        const opp = await this.requireOpenOpportunity(tx, auth, id);
        const settings = await tx.routingSettings.findUnique({ where: { organization_id: auth.organizationId } });
        await this.applyOwner(tx, auth, opp.id, input.userId, settings?.first_response_sla_minutes ?? null, opp.first_contacted_at);
        await tx.opportunityAssignment.create({
          data: { organization_id: auth.organizationId, opportunity_id: id, assigned_to: input.userId, assigned_by: auth.userId, strategy: input.userId ? "manual" : "queue", candidates: [] },
        });
        await this.audit.record(tx, auth, { action: "opportunity.assigned", resourceType: "opportunity", resourceId: id, metadata: { strategy: input.userId ? "manual" : "queue", from: opp.owner_user_id, to: input.userId } });
        return (await this.toDtos(tx, auth, [await tx.opportunity.findFirstOrThrow({ where: { id } })]))[0] as OpportunityDto;
      })
      .catch(mapDbError);
  }

  autoAssign(auth: AuthContext, id: string): Promise<OpportunityDto> {
    return this.db
      .withTenant(auth, async (tx) => {
        await this.lockRouting(tx, auth);
        await this.requireOpenOpportunity(tx, auth, id);
        await this.autoAssignTx(tx, auth, id);
        return (await this.toDtos(tx, auth, [await tx.opportunity.findFirstOrThrow({ where: { id } })]))[0] as OpportunityDto;
      })
      .catch(mapDbError);
  }

  getSettings(auth: AuthContext): Promise<RoutingSettingsDto> {
    return this.db.withTenant(auth, async (tx) => {
      const s = await tx.routingSettings.findUnique({ where: { organization_id: auth.organizationId } });
      return { strategy: (s?.strategy ?? "manual") as RoutingSettingsDto["strategy"], firstResponseSlaMinutes: s?.first_response_sla_minutes ?? null };
    });
  }

  setSettings(auth: AuthContext, input: RoutingSettingsRequest): Promise<RoutingSettingsDto> {
    return this.db.withTenant(auth, async (tx) => {
      const data = { strategy: input.strategy, first_response_sla_minutes: input.firstResponseSlaMinutes, updated_by: auth.userId };
      const existing = await tx.routingSettings.findUnique({ where: { organization_id: auth.organizationId } });
      if (existing) await tx.routingSettings.update({ where: { organization_id: auth.organizationId }, data });
      else await tx.routingSettings.create({ data: { organization_id: auth.organizationId, ...data } });
      await this.audit.record(tx, auth, { action: "routing.settings_changed", resourceType: "routing_settings", metadata: { strategy: input.strategy, sla: input.firstResponseSlaMinutes } });
      return { strategy: input.strategy, firstResponseSlaMinutes: input.firstResponseSlaMinutes };
    });
  }

  listPool(auth: AuthContext): Promise<PoolDto> {
    return this.db.withTenant(auth, async (tx) => ({ items: await this.poolDtos(tx, auth) }));
  }

  setPoolMember(auth: AuthContext, userId: string, input: PoolMemberRequest): Promise<PoolMemberDto> {
    return this.db.withTenant(auth, async (tx) => {
      const member = await tx.membership.findFirst({ where: { organization_id: auth.organizationId, user_id: userId, status: "active", role: { in: ["org_admin", "sales_manager", "seller"] } } });
      if (!member) throw conflict("Only active sellers, sales managers or admins of this organization can join the pool");
      const existing = await tx.sellerPoolMember.findFirst({ where: { organization_id: auth.organizationId, user_id: userId } });
      if (existing) await tx.sellerPoolMember.update({ where: { id: existing.id }, data: { active: input.active, max_open: input.maxOpen } });
      else await tx.sellerPoolMember.create({ data: { organization_id: auth.organizationId, user_id: userId, active: input.active, max_open: input.maxOpen, created_by: auth.userId } });
      await this.audit.record(tx, auth, { action: "routing.pool_changed", resourceType: "seller_pool", metadata: { userId, active: input.active, maxOpen: input.maxOpen } });
      return (await this.poolDtos(tx, auth)).find((m) => m.userId === userId) as PoolMemberDto;
    });
  }

  removePoolMember(auth: AuthContext, userId: string): Promise<void> {
    return this.db.withTenant(auth, async (tx) => {
      const removed = await tx.sellerPoolMember.deleteMany({ where: { organization_id: auth.organizationId, user_id: userId } });
      if (removed.count === 0) throw new NotFoundException();
      await this.audit.record(tx, auth, { action: "routing.pool_removed", resourceType: "seller_pool", metadata: { userId } });
    });
  }

  /* ---------- internals ---------- */

  /** Deterministic: fewest open opportunities, then least recently assigned (never first), then user id. Records the full candidate snapshot. */
  private async autoAssignTx(tx: Tx, auth: AuthContext, id: string): Promise<void> {
    const opp = await tx.opportunity.findFirstOrThrow({ where: { id, organization_id: auth.organizationId } });
    const pool = await tx.sellerPoolMember.findMany({ where: { organization_id: auth.organizationId, active: true } });
    const counts = pool.length
      ? await tx.opportunity.groupBy({ by: ["owner_user_id"], where: { organization_id: auth.organizationId, owner_user_id: { in: pool.map((p) => p.user_id) }, stage: { notIn: OPEN_EXCLUDED } }, _count: { _all: true } })
      : [];
    const candidates = pool
      .map((p) => {
        const open = counts.find((c) => c.owner_user_id === p.user_id)?._count._all ?? 0;
        return { userId: p.user_id, open, maxOpen: p.max_open, lastAssignedAt: p.last_assigned_at?.toISOString() ?? null, eligible: open < p.max_open };
      })
      .sort((a, b) => a.open - b.open || (a.lastAssignedAt ?? "").localeCompare(b.lastAssignedAt ?? "") || a.userId.localeCompare(b.userId));
    const chosen = candidates.find((c) => c.eligible) ?? null;
    const settings = await tx.routingSettings.findUnique({ where: { organization_id: auth.organizationId } });
    await this.applyOwner(tx, auth, id, chosen?.userId ?? null, settings?.first_response_sla_minutes ?? null, opp.first_contacted_at);
    if (chosen) await tx.sellerPoolMember.updateMany({ where: { organization_id: auth.organizationId, user_id: chosen.userId }, data: { last_assigned_at: new Date() } });
    await tx.opportunityAssignment.create({
      data: {
        organization_id: auth.organizationId, opportunity_id: id, assigned_to: chosen?.userId ?? null, assigned_by: auth.userId, strategy: chosen ? "round_robin" : "queue",
        candidates: candidates as unknown as Prisma.InputJsonValue,
      },
    });
    await this.audit.record(tx, auth, {
      action: "opportunity.assigned", resourceType: "opportunity", resourceId: id, metadata: { strategy: chosen ? "round_robin" : "queue", from: opp.owner_user_id, to: chosen?.userId ?? null },
    });
  }

  private async applyOwner(tx: Tx, auth: AuthContext, id: string, userId: string | null, slaMinutes: number | null, firstContactedAt: Date | null): Promise<void> {
    const now = new Date();
    await tx.opportunity.update({
      where: { id },
      data: {
        owner_user_id: userId, assigned_at: userId ? now : null,
        first_response_due_at: userId && slaMinutes && !firstContactedAt ? new Date(now.getTime() + slaMinutes * 60_000) : null,
      },
    });
  }

  private lockRouting(tx: Tx, auth: AuthContext) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`routing:${auth.organizationId}`}, 0))`;
  }

  private async requireOpenOpportunity(tx: Tx, auth: AuthContext, id: string) {
    const opp = await tx.opportunity.findFirst({ where: { id, organization_id: auth.organizationId } });
    if (!opp) throw new NotFoundException();
    if (opp.stage === "won" || opp.stage === "lost") throw conflict("The opportunity is closed");
    return opp;
  }

  private async poolDtos(tx: Tx, auth: AuthContext): Promise<PoolMemberDto[]> {
    const pool = await tx.sellerPoolMember.findMany({ where: { organization_id: auth.organizationId }, orderBy: { user_id: "asc" } });
    if (!pool.length) return [];
    const ids = pool.map((p) => p.user_id);
    const [users, counts] = await Promise.all([
      tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, display_name: true } }),
      tx.opportunity.groupBy({ by: ["owner_user_id"], where: { organization_id: auth.organizationId, owner_user_id: { in: ids }, stage: { notIn: OPEN_EXCLUDED } }, _count: { _all: true } }),
    ]);
    return pool.map((p) => ({
      userId: p.user_id, displayName: users.find((u) => u.id === p.user_id)?.display_name ?? "", active: p.active, maxOpen: p.max_open,
      openCount: counts.find((c) => c.owner_user_id === p.user_id)?._count._all ?? 0, lastAssignedAt: p.last_assigned_at?.toISOString() ?? null,
    }));
  }

  private async detail(tx: Tx, auth: AuthContext, id: string): Promise<OpportunityDetailDto> {
    const row = await tx.opportunity.findFirst({ where: { id, organization_id: auth.organizationId } });
    if (!row) throw new NotFoundException();
    const [history, notes, assignments] = await Promise.all([
      tx.opportunityStageHistory.findMany({ where: { organization_id: auth.organizationId, opportunity_id: id } }),
      tx.opportunityNote.findMany({ where: { organization_id: auth.organizationId, opportunity_id: id } }),
      tx.opportunityAssignment.findMany({ where: { organization_id: auth.organizationId, opportunity_id: id } }),
    ]);
    const ids = [...new Set([...history.map((h) => h.changed_by), ...notes.map((n) => n.created_by), ...assignments.map((a) => a.assigned_by), ...assignments.map((a) => a.assigned_to)].filter((x): x is string => !!x))];
    const users = ids.length ? await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, display_name: true } }) : [];
    const name = (uid: string | null) => (uid ? (users.find((u) => u.id === uid)?.display_name ?? null) : null);
    const timeline: TimelineItemDto[] = [
      ...history.map((h): TimelineItemDto => ({ kind: "stage", at: h.changed_at.toISOString(), by: name(h.changed_by), from: h.from_stage, to: h.to_stage, note: h.note })),
      ...notes.map((n): TimelineItemDto => ({ kind: "note", at: n.created_at.toISOString(), by: name(n.created_by), noteKind: n.kind, body: n.body })),
      ...assignments.map((a): TimelineItemDto => ({ kind: "assignment", at: a.created_at.toISOString(), by: name(a.assigned_by), assignedTo: name(a.assigned_to), strategy: a.strategy })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    return { ...((await this.toDtos(tx, auth, [row]))[0] as OpportunityDto), timeline };
  }

  private async toDtos(tx: Tx, auth: AuthContext, rows: OppRow[]): Promise<OpportunityDto[]> {
    if (!rows.length) return [];
    const [prospects, users] = await Promise.all([
      tx.prospect.findMany({ where: { organization_id: auth.organizationId, id: { in: rows.map((r) => r.prospect_id) } }, select: { id: true, name: true, domain_key: true } }),
      tx.user.findMany({ where: { id: { in: rows.flatMap((r) => (r.owner_user_id ? [r.owner_user_id] : [])) } }, select: { id: true, display_name: true } }),
    ]);
    return rows.map((r) => {
      const p = prospects.find((x) => x.id === r.prospect_id);
      return {
        id: r.id, leadId: r.lead_id, prospect: { id: r.prospect_id, name: p?.name ?? "", domain: p?.domain_key ?? null }, title: r.title, stage: r.stage as OpportunityDto["stage"],
        ownerUserId: r.owner_user_id, ownerName: users.find((u) => u.id === r.owner_user_id)?.display_name ?? null, assignedAt: r.assigned_at?.toISOString() ?? null,
        expectedValue: r.expected_value ? r.expected_value.toFixed(4) : null, currency: r.currency, lossReason: r.loss_reason,
        firstResponseDueAt: r.first_response_due_at?.toISOString() ?? null, firstContactedAt: r.first_contacted_at?.toISOString() ?? null, slaBreached: slaBreached(r),
        closedAt: r.closed_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(),
      };
    });
  }
}

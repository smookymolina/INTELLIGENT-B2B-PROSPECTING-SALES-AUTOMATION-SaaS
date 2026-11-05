import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { JOB_STATES, type JobDto, type JobListQuery, type JobPageDto, type JobState, type JobStatsDto, type JobType } from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService, type TenantContext } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";
import { redact } from "../http/structured-logger.js";

export type ClaimedJob = { id: string; organizationId: string; type: JobType; payload: Record<string, unknown>; attempts: number; maxAttempts: number; actorUserId: string | null };
export type PlanTarget = { organizationId: string; actorUserId: string };

/** Strips addresses, credentials and long numeric identifiers from an error and bounds its size, so the DLQ never stores PII or secrets. */
export function redactError(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : "non-error thrown";
  return redact(raw).replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]").replace(/\d{6,}/g, "[n]").replace(/\s+/g, " ").slice(0, 300);
}

/** Exponential backoff: base * 2^(attempt-1), capped. `attempt` is the number of the attempt that just failed (1-based). */
export function backoffMs(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

type JobRow = { id: string; type: string; state: string; attempts: number; max_attempts: number; run_after: Date; last_error: string | null; last_error_at: Date | null; finished_at: Date | null; created_at: Date };
const toDto = (r: JobRow): JobDto => ({
  id: r.id, type: r.type as JobType, state: r.state as JobState, attempts: r.attempts, maxAttempts: r.max_attempts, runAfter: r.run_after.toISOString(),
  lastError: r.last_error, lastErrorAt: r.last_error_at?.toISOString() ?? null, finishedAt: r.finished_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(),
});

/** PostgreSQL-backed queue. Cross-tenant steps (claim, finish, list organizations) go through narrow SECURITY DEFINER functions; everything else is tenant RLS. */
@Injectable()
export class JobsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Organizations to plan for, with the org_admin each job acts as. Keyset-paged. */
  listPlanTargets(after: string | null, limit: number): Promise<PlanTarget[]> {
    return this.db.withoutTenant(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ organization_id: string; actor_user_id: string }>>`SELECT organization_id, actor_user_id FROM jobs_list_orgs(${after}::uuid, ${limit}::int)`;
      return rows.map((r) => ({ organizationId: r.organization_id, actorUserId: r.actor_user_id }));
    });
  }

  /** Idempotent: a (organization, type, dedupeKey) that already exists creates nothing. Returns how many rows were created. */
  async enqueue(ctx: TenantContext, jobs: ReadonlyArray<{ type: JobType; dedupeKey: string; payload: Record<string, string | number>; maxAttempts: number; runAfter: Date }>): Promise<number> {
    if (jobs.length === 0) return 0;
    return this.db.withTenant(ctx, async (tx) => {
      const res = await tx.job.createMany({
        data: jobs.map((j) => ({ organization_id: ctx.organizationId, type: j.type, dedupe_key: j.dedupeKey, payload: j.payload, max_attempts: j.maxAttempts, run_after: j.runAfter })),
        skipDuplicates: true,
      });
      return res.count;
    });
  }

  claim(workerId: string, leaseSeconds: number, limit: number, now: Date): Promise<ClaimedJob[]> {
    return this.db.withoutTenant(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; organization_id: string; type: string; payload: Record<string, unknown>; attempts: number; max_attempts: number; actor_user_id: string | null }>>`
        SELECT id, organization_id, type, payload, attempts, max_attempts, actor_user_id FROM jobs_claim(${workerId}, ${leaseSeconds}::int, ${limit}::int, ${now}::timestamptz)`;
      return rows.map((r) => ({ id: r.id, organizationId: r.organization_id, type: r.type as JobType, payload: r.payload, attempts: r.attempts, maxAttempts: r.max_attempts, actorUserId: r.actor_user_id }));
    });
  }

  complete(id: string, workerId: string, now: Date): Promise<boolean> {
    return this.db.withoutTenant(async (tx) => (await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT jobs_complete(${id}::uuid, ${workerId}, ${now}::timestamptz) AS ok`)[0]?.ok === true);
  }

  /** Returns the new state, or null when this worker no longer holds the lease. */
  fail(id: string, workerId: string, error: unknown, retryAt: Date, permanent: boolean, now: Date): Promise<"failed" | "dead" | null> {
    return this.db.withoutTenant(async (tx) => {
      const r = await tx.$queryRaw<Array<{ s: string | null }>>`SELECT jobs_fail(${id}::uuid, ${workerId}, ${redactError(error)}, ${retryAt}::timestamptz, ${permanent}, ${now}::timestamptz) AS s`;
      return (r[0]?.s ?? null) as "failed" | "dead" | null;
    });
  }

  /** Cross-tenant counts for the metrics gauge (no ids, no content). */
  queueCounts(): Promise<Array<{ state: string; n: number }>> {
    return this.db.withoutTenant(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ state: string; n: bigint }>>`SELECT state, sum(n)::bigint AS n FROM jobs_stats() GROUP BY state`;
      return rows.map((r) => ({ state: r.state, n: Number(r.n) }));
    });
  }

  /* ---------- admin API (tenant scoped) ---------- */

  list(auth: AuthContext, q: JobListQuery): Promise<JobPageDto> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.job.findMany({
        where: { organization_id: auth.organizationId, ...(q.state !== "all" ? { state: q.state } : {}), ...(q.type ? { type: q.type } : {}), ...(q.cursor ? { id: { gt: q.cursor } } : {}) },
        orderBy: { id: "asc" },
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      return { items: page.map(toDto), nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
    });
  }

  stats(auth: AuthContext): Promise<JobStatsDto> {
    return this.db.withTenant(auth, async (tx) => {
      const g = await tx.job.groupBy({ by: ["state"], where: { organization_id: auth.organizationId }, _count: { _all: true } });
      const byState = Object.fromEntries(JOB_STATES.map((s) => [s, 0])) as JobStatsDto["byState"];
      for (const r of g) byState[r.state as JobState] = r._count._all;
      return { byState };
    });
  }

  /** Dead or failed -> queued with a fresh attempt budget. Safe: the job re-runs idempotent work (see WORKER.md). Audited. */
  requeue(auth: AuthContext, id: string, now: Date = new Date()): Promise<JobDto> {
    return this.db.withTenant(auth, async (tx) => {
      const cur = await tx.job.findFirst({ where: { id, organization_id: auth.organizationId } });
      if (!cur) throw new NotFoundException();
      if (cur.state !== "dead" && cur.state !== "failed") throw new ApiException(409, "CONFLICT", "Only a dead or failed job can be requeued");
      const res = await tx.job.updateMany({ where: { id, organization_id: auth.organizationId, state: { in: ["dead", "failed"] } }, data: { state: "queued", attempts: 0, run_after: now, locked_by: null, locked_until: null, finished_at: null, updated_at: now } });
      if (res.count !== 1) throw new ApiException(409, "CONFLICT", "The job changed state; reload and retry");
      await this.audit.record(tx, auth, { action: "job.requeued", resourceType: "job", resourceId: id, metadata: { type: cur.type, previousState: cur.state, previousAttempts: cur.attempts } });
      return toDto(await tx.job.findFirstOrThrow({ where: { id, organization_id: auth.organizationId } }));
    });
  }
}

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { HttpException, Inject, Injectable, Logger } from "@nestjs/common";
import { UuidParam, type JobType } from "@prospecting/contracts";
import { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService, type TenantContext } from "../db/prisma.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { SequencesService } from "../sequences/sequences.service.js";
import { backoffMs, JobsService, type ClaimedJob } from "./jobs.service.js";
import { markTick, recordJob, setQueueState, writeMetricsFile } from "./worker-metrics.js";

export type WorkerConfig = {
  pollMs: number;
  planEveryMs: number;
  batch: number;
  leaseSeconds: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  runDueLimit: number;
  metricsFile: string | null;
};
const int = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    pollMs: int(env.WORKER_POLL_MS, 5_000, 100, 600_000),
    planEveryMs: int(env.WORKER_PLAN_EVERY_MS, 60_000, 1_000, 3_600_000),
    batch: int(env.WORKER_BATCH, 5, 1, 100),
    leaseSeconds: int(env.WORKER_LEASE_SECONDS, 120, 5, 3_600),
    maxAttempts: int(env.WORKER_MAX_ATTEMPTS, 5, 1, 20),
    backoffBaseMs: int(env.WORKER_BACKOFF_BASE_MS, 30_000, 10, 3_600_000),
    backoffCapMs: int(env.WORKER_BACKOFF_CAP_MS, 900_000, 10, 86_400_000),
    runDueLimit: int(env.WORKER_RUN_DUE_LIMIT, 50, 1, 200),
    metricsFile: env.WORKER_METRICS_FILE?.trim() || null,
  };
}

const RunDuePayload = z.strictObject({ campaignId: UuidParam, limit: z.number().int().min(1).max(200).default(50) });
const ScanPayload = z.strictObject({});

/** 4xx (except 429) and invalid payloads can never succeed by retrying: straight to the dead-letter queue. */
function isPermanent(e: unknown): boolean {
  if (e instanceof z.ZodError) return true;
  if (e instanceof HttpException) return e.getStatus() >= 400 && e.getStatus() < 500 && e.getStatus() !== 429;
  return false;
}

export type TickResult = { planned: number; claimed: number; succeeded: number; retried: number; dead: number; lostLease: number };

/**
 * The only caller of `SequencesService.runDue` in production. Plans jobs (idempotent per window), claims them with a lease and runs each one
 * in the tenant context of that organization's org_admin through `withTenant` (role `app_runtime`, RLS applies). Consent, opt-out, suppression,
 * frequency cap, approval and window are re-checked by `runDue` for every step; a retry cannot double-send because (enrolment, step) is
 * unique in sequence_deliveries and the sandbox channel is idempotent on its key. Channel: sandbox (mock) only.
 */
@Injectable()
export class WorkerService {
  private readonly log = new Logger("Worker");
  /** Replaceable clock (tests). */
  now: () => Date = () => new Date();
  config: WorkerConfig = configFromEnv();
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private lastPlanBucket = -1;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private loopDone: Promise<unknown> = Promise.resolve();
  private wake: (() => void) | null = null;

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SequencesService) private readonly sequences: SequencesService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  /* ---------- planning ---------- */

  /** Creates this window's jobs: sequence.run_due for every running campaign with a sequence, notifications.scan_due per organization. Idempotent per window. */
  async plan(): Promise<number> {
    const now = this.now();
    const bucket = Math.floor(now.getTime() / this.config.planEveryMs);
    let created = 0;
    let after: string | null = null;
    for (;;) {
      const targets = await this.jobs.listPlanTargets(after, 200);
      for (const t of targets) {
        const ctx: TenantContext = { organizationId: t.organizationId, userId: t.actorUserId, role: "org_admin" };
        const campaigns = await this.db.withTenant(ctx, (tx) => tx.campaign.findMany({ where: { organization_id: t.organizationId, state: "running", steps: { some: {} } }, select: { id: true }, orderBy: { id: "asc" }, take: 500 }));
        const base = { maxAttempts: this.config.maxAttempts, runAfter: now };
        created += await this.jobs.enqueue(ctx, [
          { type: "notifications.scan_due", dedupeKey: `org:${bucket}`, payload: {}, ...base },
          ...campaigns.map((c) => ({ type: "sequence.run_due" as const, dedupeKey: `${c.id}:${bucket}`, payload: { campaignId: c.id, limit: this.config.runDueLimit }, ...base })),
        ]);
      }
      if (targets.length < 200) break;
      after = targets[targets.length - 1]?.organizationId ?? null;
    }
    this.lastPlanBucket = bucket;
    return created;
  }

  /* ---------- execution ---------- */

  async tick(): Promise<TickResult> {
    const res: TickResult = { planned: 0, claimed: 0, succeeded: 0, retried: 0, dead: 0, lostLease: 0 };
    const now = this.now();
    if (Math.floor(now.getTime() / this.config.planEveryMs) !== this.lastPlanBucket) res.planned = await this.plan();
    const claimed = await this.jobs.claim(this.workerId, this.config.leaseSeconds, this.config.batch, this.now());
    res.claimed = claimed.length;
    for (const job of claimed) {
      if (this.stopping) break; // graceful stop: finish nothing new (unclaimed remainder is reclaimed after its lease)
      const outcome = await this.processOne(job);
      if (outcome === "succeeded") res.succeeded += 1;
      else if (outcome === "retry") res.retried += 1;
      else if (outcome === "dead") res.dead += 1;
      else res.lostLease += 1;
    }
    setQueueState(await this.jobs.queueCounts().catch(() => []));
    markTick(this.now());
    if (this.config.metricsFile) {
      try { writeMetricsFile(this.config.metricsFile); } catch { this.log.warn("event=metrics_file_failed"); }
    }
    return res;
  }

  async processOne(job: ClaimedJob): Promise<"succeeded" | "retry" | "dead" | "lost_lease"> {
    const t0 = process.hrtime.bigint();
    const secs = () => Number(process.hrtime.bigint() - t0) / 1e9;
    const actor = job.actorUserId;
    try {
      if (!actor) throw new HttpException("The organization has no active org_admin to run as", 409);
      await this.run(job, actor);
      const ok = await this.jobs.complete(job.id, this.workerId, this.now());
      const outcome = ok ? "succeeded" : "lost_lease";
      recordJob(job.type, outcome, secs());
      this.log.log(`event=job_${outcome} type=${job.type} job=${job.id} attempt=${job.attempts}/${job.maxAttempts}`);
      return outcome;
    } catch (e) {
      const now = this.now();
      const retryAt = new Date(now.getTime() + backoffMs(job.attempts, this.config.backoffBaseMs, this.config.backoffCapMs));
      const state = await this.jobs.fail(job.id, this.workerId, e, retryAt, isPermanent(e), now);
      if (state === null) {
        recordJob(job.type, "lost_lease", secs());
        return "lost_lease";
      }
      const outcome = state === "dead" ? "dead" : "retry";
      recordJob(job.type, outcome, secs());
      this.log.warn(`event=job_${outcome} type=${job.type} job=${job.id} attempt=${job.attempts}/${job.maxAttempts} error=${e instanceof Error ? e.name : "unknown"}`);
      if (actor) {
        const ctx: AuthContext = { sessionId: "worker", userId: actor, organizationId: job.organizationId, role: "org_admin", requestId: `job:${job.id}` };
        await this.db
          .withTenant(ctx, (tx) => this.audit.record(tx, ctx, { action: state === "dead" ? "job.dead" : "job.retry_scheduled", resourceType: "job", resourceId: job.id, metadata: { type: job.type, attempt: job.attempts, maxAttempts: job.maxAttempts, ...(state === "failed" ? { retryAt: retryAt.toISOString() } : {}) } }))
          .catch(() => this.log.warn(`event=job_audit_failed job=${job.id}`));
      }
      return outcome;
    }
  }

  private async run(job: ClaimedJob, actor: string): Promise<void> {
    const ctx: AuthContext = { sessionId: "worker", userId: actor, organizationId: job.organizationId, role: "org_admin", requestId: `job:${job.id}` };
    const handlers: Record<JobType, () => Promise<unknown>> = {
      "sequence.run_due": async () => {
        const p = RunDuePayload.parse(job.payload);
        return this.sequences.runDue(ctx, p.campaignId, p.limit);
      },
      "notifications.scan_due": async () => {
        ScanPayload.parse(job.payload);
        return this.notifications.scanDue(ctx, { now: this.now() });
      },
    };
    const h = handlers[job.type];
    if (!h) throw new HttpException(`Unknown job type`, 400);
    await h();
  }

  /* ---------- loop ---------- */

  private stopping = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.log.log(`event=worker_started id=${this.workerId} poll_ms=${this.config.pollMs} plan_every_ms=${this.config.planEveryMs} channel=sandbox`);
    const loop = async (): Promise<void> => {
      while (this.running) {
        await this.tick().catch((e: unknown) => this.log.error(`event=tick_failed error=${e instanceof Error ? e.name : "unknown"}`));
        if (!this.running) break;
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          this.timer = setTimeout(resolve, this.config.pollMs);
        });
      }
    };
    this.loopDone = loop();
  }

  /** Graceful stop: no new tick starts, the running one finishes its current job, then resolves. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    await this.loopDone;
    this.log.log(`event=worker_stopped id=${this.workerId}`);
  }
}

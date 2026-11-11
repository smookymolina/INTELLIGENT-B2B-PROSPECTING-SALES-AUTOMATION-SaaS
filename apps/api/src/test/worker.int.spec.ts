import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { PrismaService } from "../db/prisma.service.js";
import { PrivacyService } from "../privacy/privacy.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { EmailChannels } from "../campaigns/channels.js";
import { CampaignsService } from "../campaigns/campaigns.service.js";
import { DraftDeliveryService } from "../drafts/draft-delivery.service.js";
import { JobsService, backoffMs, redactError } from "../jobs/jobs.service.js";
import { renderWorkerMetrics, resetWorkerMetrics } from "../jobs/worker-metrics.js";
import { configFromEnv, WorkerService } from "../jobs/worker.service.js";
import { SequencesService } from "../sequences/sequences.service.js";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/**
 * Worker (PostgreSQL-backed queue): automatic processing with an injected clock, retries with backoff and DLQ without double sends,
 * SKIP LOCKED / lease, tenant isolation and RBAC on the admin endpoints, and per-window idempotency.
 * Run with TEST_DATABASE_URL=postgresql://app:app@localhost:5432/prospecting_worker_test
 */
// Every tick plans and runs the work of ALL organizations in the (shared, accumulating) test database, so allow time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
let api: Api;
let worker: WorkerService;
let jobs: JobsService;
type Account = { token: string; orgId: string; userId: string };

// The production worker plans for EVERY organization. In the full suite the database holds hundreds of organizations from other specs, which would
// fill the claim batch and starve this spec's jobs; so the planner is scoped to the organizations this spec creates (see beforeAll).
const mine = new Set<string>();
async function register(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label}` } });
  const me = await api.call("GET", "/me", { token: res.body.token });
  mine.add(res.body.organization.id as string);
  return { token: res.body.token, orgId: res.body.organization.id, userId: me.body.user.id };
}
const T0 = "2026-11-09T16:00:00.000Z"; // Monday 10:00 America/Mexico_City
const at = (ms = 0) => new Date(new Date(T0).getTime() + ms);
// Real-clock lag in whole weeks (keeps weekday/hour of the window): DB defaults and JobsService.requeue use the real clock, which has outgrown T0.
const lagWeeks = () => Math.ceil(Math.max(0, Date.now() - new Date(T0).getTime()) / (7 * 86_400_000)) * 7 * 86_400_000;
const clock = (ms = 0) => {
  const d = at(ms);
  api.app.get(SequencesService).now = () => d;
  worker.now = () => d;
};
const iso = (offsetMs = -60_000) => new Date(new Date("2026-11-09T16:00:00.000Z").getTime() + offsetMs).toISOString(); // anchored to the injected clock, not the real one
const outbox = () => api.app.get(EmailChannels).sandbox.outbox;
const SEQ = {
  timezone: "America/Mexico_City", windowStart: "09:00", windowEnd: "18:00", weekdays: [1, 2, 3, 4, 5],
  steps: [
    { delayHours: 0, subject: "Hola {{company}}", body: "Primer contacto con {{company}}. Baja: {{unsubscribe_url}}" },
    { delayHours: 48, subject: "Seguimiento {{company}}", body: "Segundo mensaje. Baja: {{unsubscribe_url}}" },
  ],
};

async function contact(t: string) {
  const domain = `wk-${randomUUID().slice(0, 8)}.example`;
  const p = (await api.call("POST", "/prospects", { token: t, body: { name: `Co ${randomUUID().slice(0, 5)}`, domain } })).body as { id: string };
  const c = (await api.call("POST", `/prospects/${p.id}/contacts`, { token: t, body: { address: `compras@${domain}`, displayName: "Compras", source: "Formulario web, 2026-09-01" } })).body as { id: string };
  expect((await api.call("POST", `/contacts/${c.id}/consent`, { token: t, body: { event: "granted", evidence: "Casilla marcada en el formulario web, 2026-09-01", occurredAt: iso() } })).status).toBe(201);
  return c.id;
}
async function runningCampaign(t: string): Promise<string> {
  const c = (await api.call("POST", "/campaigns", { token: t, body: { name: "Secuencia worker", subject: "base", body: "base {{unsubscribe_url}}" } })).body as { id: string };
  expect((await api.call("PUT", `/campaigns/${c.id}/sequence`, { token: t, body: SEQ })).status).toBe(200);
  expect((await api.call("POST", `/campaigns/${c.id}/approve`, { token: t })).status).toBe(200);
  expect((await api.call("POST", `/campaigns/${c.id}/launch`, { token: t })).status).toBe(200);
  return c.id;
}
/** A running campaign with `n` enrolled, consenting contacts, all due at T0. Nothing has been sent. */
async function enrolled(t: string, n = 1): Promise<string> {
  const id = await runningCampaign(t);
  for (let i = 0; i < n; i++) await contact(t);
  expect((await api.call("POST", `/campaigns/${id}/sequence/enroll`, { token: t })).body.enrolled).toBe(n);
  return id;
}
const jobRows = async (orgId: string, type?: string) =>
  (await owner.query("SELECT id, type, state, attempts, max_attempts, run_after, last_error, locked_by FROM jobs WHERE organization_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY created_at, id", [orgId, type ?? null])).rows as Array<{ id: string; type: string; state: string; attempts: number; max_attempts: number; run_after: Date; last_error: string | null; locked_by: string | null }>;
const deliveries = async (campaignId: string) => (await owner.query("SELECT enrollment_id, step_no FROM sequence_deliveries WHERE campaign_id = $1", [campaignId])).rows as Array<{ enrollment_id: string; step_no: number }>;
const audit = async (orgId: string, action: string) => (await owner.query("SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1 AND action = $2", [orgId, action])).rows[0].n as number;

type Sendable = { send: (...a: unknown[]) => Promise<unknown> };
/** Makes the sandbox channel throw while `failing()` is true; returns a restore function. */
function flaky(failing: () => boolean, message: string): () => void {
  const ch = api.app.get(EmailChannels).sandbox as unknown as Sendable;
  const original = ch.send;
  ch.send = async function (this: unknown, ...a: unknown[]) {
    if (failing()) throw new Error(message);
    return original.apply(this, a);
  };
  return () => {
    ch.send = original;
  };
}

beforeAll(async () => {
  api = await startApi();
  worker = api.app.get(WorkerService);
  jobs = api.app.get(JobsService);
  const allTargets = jobs.listPlanTargets.bind(jobs);
  jobs.listPlanTargets = async (after, limit) => {
    if (after) return [];
    const out: Awaited<ReturnType<typeof allTargets>> = [];
    for (let cursor: string | null = null; ; ) {
      const page = await allTargets(cursor, limit);
      out.push(...page.filter((t) => mine.has(t.organizationId)));
      if (page.length < limit) return out;
      cursor = page[page.length - 1]?.organizationId ?? null;
    }
  };
});
afterAll(async () => {
  api.app.get(SequencesService).now = () => new Date();
  await api.close();
});
beforeEach(() => {
  outbox().length = 0;
  worker.config = { ...configFromEnv({}), batch: 100, maxAttempts: 3, backoffBaseMs: 1000, backoffCapMs: 60_000, planEveryMs: 60_000, retentionEveryMs: 0, metricsFile: null }; // the daily retention.purge job has its own spec (retention.int.spec.ts)
  clock();
});
afterEach(() => resetWorkerMetrics());

describe("pure helpers", () => {
  it("backs off exponentially with a cap", () => {
    expect([1, 2, 3, 4, 10].map((a) => backoffMs(a, 1000, 5000))).toEqual([1000, 2000, 4000, 5000, 5000]);
  });
  it("redacts addresses, secrets, ids and long numbers from stored errors", () => {
    const m = redactError(new Error(`SMTP failed for ana@cliente.example token=abc123 org ${randomUUID()} acct 12345678901 Bearer xyz.abc`));
    expect(m).not.toMatch(/@|abc123|12345678901|xyz\.abc/);
    expect(m).toContain("[REDACTED_EMAIL]");
    expect(m.length).toBeLessThanOrEqual(300);
  });
  it("does not start a loop just by being created", () => {
    expect((worker as unknown as { running: boolean }).running).toBe(false);
  });
});

describe("automatic processing (criterion 1)", () => {
  it("sends a due sequence step through the worker, without calling the endpoint, and honours the following windows", async () => {
    const a = await register("wk-auto");
    const cid = await enrolled(a.token);
    expect(outbox()).toHaveLength(0); // enrolling never sends
    await worker.plan();
    const res = await worker.tick();
    expect(res.claimed).toBeGreaterThanOrEqual(2);
    expect(await deliveries(cid)).toHaveLength(1);
    const rows = await jobRows(a.orgId);
    expect(rows.map((r) => `${r.type}:${r.state}`).sort()).toEqual(["notifications.scan_due:succeeded", "prospects.expire_due:succeeded", "sequence.run_due:succeeded"]);
    // same window: nothing new is planned, so nothing else is sent (and step 2 is not due for 48 h anyway)
    await worker.tick();
    expect(await deliveries(cid)).toHaveLength(1);
    // 49 h later (Wednesday 11:00 local): a new window plans a new job and the second step goes out
    clock(49 * 3_600_000 + lagWeeks());
    await worker.tick(); // (the shared test database also holds other tests' due enrolments, so assert on this campaign's deliveries)
    expect((await deliveries(cid)).map((d) => d.step_no).sort()).toEqual([1, 2]);
    expect((await jobRows(a.orgId, "sequence.run_due")).length).toBe(2);
    expect(renderWorkerMetrics()).toContain('worker_jobs_total{type="sequence.run_due",outcome="succeeded"}');
  });

  it("keeps every safety check: a withdrawn consent stops the enrolment and nothing is sent", async () => {
    const a = await register("wk-consent");
    const cid = await runningCampaign(a.token);
    const contactId = await contact(a.token);
    await api.call("POST", `/campaigns/${cid}/sequence/enroll`, { token: a.token });
    await api.call("POST", `/contacts/${contactId}/consent`, { token: a.token, body: { event: "withdrawn", evidence: "Baja por telefono", occurredAt: iso(-1000) } });
    await worker.plan();
    await worker.tick();
    expect(await deliveries(cid)).toHaveLength(0);
    expect((await owner.query("SELECT state, stop_reason FROM sequence_enrollments WHERE campaign_id = $1", [cid])).rows[0]).toMatchObject({ state: "stopped", stop_reason: "opted_out" });
  });

  it("does not plan a draft or paused campaign and never runs on its own over HTTP", async () => {
    const a = await register("wk-draft");
    const c = (await api.call("POST", "/campaigns", { token: a.token, body: { name: "Borrador", subject: "x", body: "x {{unsubscribe_url}}" } })).body as { id: string };
    await api.call("PUT", `/campaigns/${c.id}/sequence`, { token: a.token, body: SEQ });
    await worker.plan();
    expect(await jobRows(a.orgId, "sequence.run_due")).toHaveLength(0);
    expect(await jobRows(a.orgId, "notifications.scan_due")).toHaveLength(1);
  });
});

describe("retries, backoff and DLQ without double sends (criterion 2)", () => {
  it("retries with exponential backoff, ends in the DLQ after max_attempts, then an admin requeue succeeds exactly once", async () => {
    const a = await register("wk-retry");
    const cid = await enrolled(a.token);
    let broken = true;
    const restore = flaky(() => broken, "SMTP timeout for compras@x.example token=SECRET123 acct 123456789");
    try {
      await worker.plan();
      await worker.tick(); // attempt 1
      let [job] = await jobRows(a.orgId, "sequence.run_due");
      expect(job).toMatchObject({ state: "failed", attempts: 1 });
      expect(job?.run_after.toISOString()).toBe(at(1000).toISOString());
      await worker.tick(); // not due yet: untouched
      expect((await jobRows(a.orgId, "sequence.run_due"))[0]?.attempts).toBe(1);
      clock(1000);
      await worker.tick(); // attempt 2, backoff 2 s
      [job] = await jobRows(a.orgId, "sequence.run_due");
      expect(job).toMatchObject({ state: "failed", attempts: 2 });
      expect(job?.run_after.toISOString()).toBe(at(3000).toISOString());
      clock(3000);
      await worker.tick(); // attempt 3 = max -> dead-letter queue
      [job] = await jobRows(a.orgId, "sequence.run_due");
      expect(job).toMatchObject({ state: "dead", attempts: 3 });
      expect(job?.last_error).toBeTruthy();
      expect(job?.last_error).not.toMatch(/@|SECRET123|123456789/);
      clock(60_000);
      await worker.tick(); // a dead job is never picked again
      expect((await jobRows(a.orgId, "sequence.run_due"))[0]?.attempts).toBe(3);
      expect(outbox()).toHaveLength(0);
      expect(await deliveries(cid)).toHaveLength(0);
      // 2 retries of the first job + 1 attempt of the job planned for the next window (the enrolment is still due and the channel still broken)
      expect(await audit(a.orgId, "job.retry_scheduled")).toBe(3);
      expect(await audit(a.orgId, "job.dead")).toBe(1);
      expect(renderWorkerMetrics()).toMatch(/worker_job_retries_total\{type="sequence.run_due"\} \d+/);
      expect(renderWorkerMetrics()).toMatch(/worker_jobs_total\{type="sequence.run_due",outcome="dead"\} \d+/);

      // DLQ is visible to the admin, who fixes the cause and requeues
      const dlq = await api.call("GET", "/admin/jobs", { token: a.token });
      expect(dlq.status).toBe(200);
      expect(dlq.body.items.map((i: { id: string }) => i.id)).toEqual([job?.id]);
      expect(JSON.stringify(dlq.body)).not.toMatch(/SECRET123|@/);
      broken = false;
      const rq = await api.call("POST", `/admin/jobs/${job?.id}/requeue`, { token: a.token });
      expect(rq.status).toBe(200);
      expect(rq.body).toMatchObject({ state: "queued", attempts: 0 });
      expect((await api.call("POST", `/admin/jobs/${job?.id}/requeue`, { token: a.token })).status).toBe(409); // no longer dead
      expect(await audit(a.orgId, "job.requeued")).toBe(1);
      clock(120_000 + lagWeeks());
      await worker.tick();
      expect((await jobRows(a.orgId, "sequence.run_due"))[0]).toMatchObject({ state: "succeeded", attempts: 1 });
      expect(outbox()).toHaveLength(1);
      expect(await deliveries(cid)).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("a retry after a partial run does not resend what was already delivered", async () => {
    const a = await register("wk-partial");
    const cid = await enrolled(a.token, 2);
    let calls = 0;
    const restore = flaky(() => ++calls === 2, "transient network error"); // the 2nd send of the first run fails once
    try {
      await worker.plan();
      await worker.tick();
      expect((await jobRows(a.orgId, "sequence.run_due"))[0]).toMatchObject({ state: "failed", attempts: 1 });
      expect(outbox()).toHaveLength(1);
      clock(1000);
      await worker.tick();
      expect((await jobRows(a.orgId, "sequence.run_due"))[0]).toMatchObject({ state: "succeeded", attempts: 2 });
      expect(outbox()).toHaveLength(2); // not 3
      const d = await deliveries(cid);
      expect(d).toHaveLength(2);
      expect(new Set(d.map((x) => x.enrollment_id)).size).toBe(2); // exactly one step-1 delivery per enrolment
    } finally {
      restore();
    }
  });

  it("an invalid payload is a permanent failure: straight to the DLQ without retries", async () => {
    const a = await register("wk-perm");
    await owner.query("INSERT INTO jobs (organization_id, type, dedupe_key, payload, max_attempts, run_after) VALUES ($1, 'sequence.run_due', 'bad', '{\"campaignId\":\"nope\"}', 5, $2)", [a.orgId, at()]);
    await worker.tick();
    expect((await jobRows(a.orgId, "sequence.run_due"))[0]).toMatchObject({ state: "dead", attempts: 1 });
  });
});

describe("concurrency and leases (criteria 3 and 4)", () => {
  it("two workers claiming at once never take the same job", async () => {
    const a = await register("wk-conc");
    for (let i = 0; i < 4; i++) await runningCampaign(a.token);
    await worker.plan();
    const [w1, w2] = await Promise.all([jobs.claim("w1", 60, 100, at()), jobs.claim("w2", 60, 100, at())]);
    const mine = (xs: typeof w1) => xs.filter((j) => j.organizationId === a.orgId);
    const ids1 = mine(w1).map((j) => j.id);
    const ids2 = mine(w2).map((j) => j.id);
    expect(ids1.filter((id) => ids2.includes(id))).toEqual([]);
    expect(new Set([...ids1, ...ids2]).size).toBe(6); // 4 campaigns + 1 notifications scan + 1 prospects.expire_due
    expect([...mine(w1), ...mine(w2)].every((j) => j.attempts === 1 && j.actorUserId === a.userId)).toBe(true);
    const rows = await jobRows(a.orgId);
    expect(rows.every((r) => r.state === "running" && (r.locked_by === "w1" || r.locked_by === "w2"))).toBe(true);
    for (const j of mine(w1)) expect(await jobs.complete(j.id, "w1", at())).toBe(true);
    for (const j of mine(w2)) expect(await jobs.complete(j.id, "w2", at())).toBe(true);
  });

  it("two WorkerService ticks in parallel send each step exactly once", async () => {
    const a = await register("wk-two");
    const cid = await enrolled(a.token, 3);
    await worker.plan();
    const second = new WorkerService(api.app.get(PrismaService), jobs, api.app.get(AuditService), api.app.get(SequencesService), api.app.get(NotificationsService), api.app.get(PrivacyService), api.app.get(CampaignsService), api.app.get(DraftDeliveryService));
    second.now = worker.now;
    second.config = worker.config;
    await Promise.all([worker.tick(), second.tick()]);
    expect(outbox()).toHaveLength(3);
    expect(await deliveries(cid)).toHaveLength(3);
    expect((await jobRows(a.orgId)).every((r) => r.state === "succeeded" && r.attempts === 1)).toBe(true);
  });

  it("recovers a job whose lease expired, fences the old holder, and dead-letters it when no attempts are left", async () => {
    const a = await register("wk-lease");
    await runningCampaign(a.token);
    await worker.plan();
    const first = (await jobs.claim("w1", 10, 100, at())).filter((j) => j.organizationId === a.orgId);
    expect(first).toHaveLength(3); // sequence.run_due + notifications.scan_due + prospects.expire_due
    expect((await jobs.claim("w2", 10, 100, at(5_000))).filter((j) => j.organizationId === a.orgId)).toHaveLength(0); // lease still valid
    const again = (await jobs.claim("w2", 10, 100, at(11_000))).filter((j) => j.organizationId === a.orgId);
    expect(again.map((j) => j.id).sort()).toEqual(first.map((j) => j.id).sort());
    expect(again.every((j) => j.attempts === 2)).toBe(true);
    // w1 woke up late: it can neither complete nor fail the job any more
    expect(await jobs.complete(first[0]!.id, "w1", at(12_000))).toBe(false);
    expect(await jobs.fail(first[0]!.id, "w1", new Error("late"), at(20_000), false, at(12_000))).toBeNull();
    expect(await jobs.complete(again[0]!.id, "w2", at(12_000))).toBe(true);
  });

  it("a worker that vanishes after its last attempt leaves the job dead, not looping", async () => {
    const a = await register("wk-lease2");
    await runningCampaign(a.token);
    await worker.plan();
    const mine = (await jobs.claim("w1", 10, 100, at())).filter((j) => j.organizationId === a.orgId);
    const target = mine[0]!;
    await owner.query("UPDATE jobs SET max_attempts = 1 WHERE id = $1", [target.id]);
    const later = await jobs.claim("w2", 10, 100, at(60_000));
    expect(later.some((j) => j.id === target.id)).toBe(false);
    expect((await owner.query("SELECT state, last_error FROM jobs WHERE id = $1", [target.id])).rows[0]).toMatchObject({ state: "dead", last_error: "lease expired after the last attempt" });
  });
});

describe("isolation and RBAC (criterion 5)", () => {
  it("each tenant sees and requeues only its own jobs; roles without jobs:manage get 403", async () => {
    const a = await register("wk-iso-a");
    const b = await register("wk-iso-b");
    await runningCampaign(a.token);
    await runningCampaign(b.token);
    await worker.plan();
    const mineA = (await api.call("GET", "/admin/jobs?state=all", { token: a.token })).body.items as Array<{ id: string }>;
    const idsA = (await jobRows(a.orgId)).map((r) => r.id).sort();
    const idsB = (await jobRows(b.orgId)).map((r) => r.id).sort();
    expect(mineA.map((i) => i.id).sort()).toEqual(idsA);
    expect(idsA.some((id) => idsB.includes(id))).toBe(false);
    expect((await api.call("GET", "/admin/jobs/stats", { token: a.token })).body.byState.queued).toBe(idsA.length);
    await owner.query("UPDATE jobs SET state = 'dead', attempts = 5, finished_at = now() WHERE id = $1", [idsB[0]]);
    expect((await api.call("POST", `/admin/jobs/${idsB[0]}/requeue`, { token: a.token })).status).toBe(404);

    const cm = await seedMember(a.orgId, "campaign_manager");
    const tok = (await api.call("POST", "/auth/login", { body: { email: cm.email, password: PASSWORD } })).body.token as string;
    expect((await api.call("GET", "/admin/jobs", { token: tok })).status).toBe(403);
    expect((await api.call("GET", "/admin/jobs/stats", { token: tok })).status).toBe(403);
    expect((await api.call("POST", `/admin/jobs/${idsA[0]}/requeue`, { token: tok })).status).toBe(403);
    expect((await api.call("GET", "/admin/jobs")).status).toBe(401);
  });

  it("RLS is enforced by PostgreSQL itself on the jobs table", async () => {
    const a = await register("wk-rls-a");
    const b = await register("wk-rls-b");
    await runningCampaign(a.token);
    await runningCampaign(b.token);
    await worker.plan();
    const seen = await asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, (c) => c.query("SELECT DISTINCT organization_id FROM jobs"));
    expect(seen.rows.map((r) => r.organization_id)).toEqual([a.orgId]);
    const none = await asRuntime({}, (c) => c.query("SELECT 1 FROM jobs"));
    expect(none.rowCount).toBe(0);
    const ins = (role: string, org: string) => asRuntime({ organizationId: a.orgId, userId: a.userId, role }, (c) => c.query("INSERT INTO jobs (organization_id, type, dedupe_key) VALUES ($1, 'notifications.scan_due', $2)", [org, randomUUID()]));
    await expect(ins("org_admin", b.orgId)).rejects.toThrow(/row-level security/);
    await expect(ins("campaign_manager", a.orgId)).rejects.toThrow(/row-level security/);
    // a tenant cannot touch the lease or the attempt counters of its jobs
    await expect(asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, (c) => c.query("UPDATE jobs SET locked_by = 'x', last_error = 'y'"))).rejects.toThrow(/permission denied/);
  });
});

describe("idempotency per window (criterion 6)", () => {
  it("planning the same window twice, even concurrently, creates no duplicate jobs", async () => {
    const a = await register("wk-idem");
    await runningCampaign(a.token);
    await worker.plan();
    const before = await jobRows(a.orgId);
    expect(before).toHaveLength(3);
    await Promise.all([worker.plan(), worker.plan(), worker.plan()]);
    expect(await jobRows(a.orgId)).toHaveLength(3);
    // direct duplicate enqueue is a no-op too
    const ctx = { organizationId: a.orgId, userId: a.userId, role: "org_admin" } as const;
    const dup = await jobs.enqueue(ctx, [{ type: "notifications.scan_due", dedupeKey: `org:${Math.floor(at().getTime() / 60_000)}`, payload: {}, maxAttempts: 3, runAfter: at() }]);
    expect(dup).toBe(0);
    // the next window is a new job
    clock(61_000);
    await worker.plan();
    expect(await jobRows(a.orgId)).toHaveLength(5);
  });

  it("reports the queue as Prometheus text without tenant data", async () => {
    await worker.tick();
    const text = renderWorkerMetrics();
    expect(text).toContain("# TYPE worker_queue_jobs gauge");
    expect(text).toContain("worker_last_tick_timestamp_seconds");
    expect(text).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

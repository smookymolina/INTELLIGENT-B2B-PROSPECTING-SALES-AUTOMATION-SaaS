import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RETENTION_CLASSES, RETENTION_DEFAULT_DAYS } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { JobsService } from "../jobs/jobs.service.js";
import { configFromEnv, WorkerService } from "../jobs/worker.service.js";
import { PrivacyService } from "../privacy/privacy.service.js";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/**
 * Automatic retention purge: owner-decided defaults (sessions 30, invitations 30, import_jobs 90, finished jobs 30 days), per-organization override
 * or disable (0), dry-run, the daily `retention.purge` worker job, tenant isolation and idempotency. The clock is injected (NOW): nothing here
 * depends on the real date. Run with TEST_DATABASE_URL=postgresql://app:app@localhost:5432/prospecting_ret_test
 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const NOW = new Date("2026-06-01T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let api: Api;
let worker: WorkerService;
let privacy: PrivacyService;
type Account = { token: string; orgId: string; userId: string };
// The worker plans for every organization of the (accumulating) test database; scope it to the organizations of this spec.
const mine = new Set<string>();

async function register(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label}` } });
  const me = await api.call("GET", "/me", { token: res.body.token });
  mine.add(res.body.organization.id as string);
  return { token: res.body.token, orgId: res.body.organization.id, userId: me.body.user.id };
}
const ctxOf = (a: Account): AuthContext => ({ sessionId: "test", userId: a.userId, organizationId: a.orgId, role: "org_admin", requestId: "test" });
const setPolicy = (t: string, policies: { dataClass: string; retentionDays: number }[]) => api.call("PUT", "/privacy/retention", { token: t, body: { policies } });

type Seed = Record<"oldImport" | "newImport" | "oldSession" | "newSession" | "oldInv" | "newInv" | "pendingInv" | "oldDone" | "oldDead" | "newDone" | "oldQueued" | "oldFailed", string>;
const EXPIRED: Array<[string, keyof Seed]> = [["import_jobs", "oldImport"], ["sessions", "oldSession"], ["invitations", "oldInv"], ["jobs", "oldDone"], ["jobs", "oldDead"]];
const KEPT: Array<[string, keyof Seed]> = [["import_jobs", "newImport"], ["sessions", "newSession"], ["invitations", "newInv"], ["invitations", "pendingInv"], ["jobs", "newDone"], ["jobs", "oldQueued"], ["jobs", "oldFailed"]];

/** Rows on both sides of every default term, relative to NOW. Expired by default: 1 import job, 1 session, 1 invitation, 2 queue rows. */
async function seed(a: Account): Promise<Seed> {
  const s = Object.fromEntries(["oldImport", "newImport", "oldSession", "newSession", "oldInv", "newInv", "pendingInv", "oldDone", "oldDead", "newDone", "oldQueued", "oldFailed"].map((k) => [k, randomUUID()])) as Seed;
  const imp = (id: string, created: string) =>
    owner.query(
      `INSERT INTO import_jobs (id, organization_id, kind, mode, status, file_hash, total_rows, created_count, updated_count, unchanged_count, error_count, errors, created_by, created_at)
       VALUES ($1, $2, 'prospects', 'apply', 'applied', repeat('a', 64), 1, 1, 0, 0, 0, '[]', $3, $4)`, [id, a.orgId, a.userId, created]);
  await imp(s.oldImport, ago(100)); // > 90 days
  await imp(s.newImport, ago(80)); // < 90 days
  const ses = (id: string, expires: string) => owner.query("INSERT INTO sessions (id, organization_id, user_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [id, a.orgId, a.userId, randomUUID(), expires, ago(120)]);
  await ses(s.oldSession, ago(40)); // expired > 30 days ago
  await ses(s.newSession, ago(10)); // expired, but within the term
  const inv = (id: string, expires: string) => owner.query("INSERT INTO invitations (id, organization_id, email, role, token_hash, invited_by, expires_at, created_at) VALUES ($1, $2, $3, 'viewer', $4, $5, $6, $7)", [id, a.orgId, `${id.slice(0, 8)}@example.test`, randomUUID(), a.userId, expires, ago(120)]);
  await inv(s.oldInv, ago(45));
  await inv(s.newInv, ago(5));
  await inv(s.pendingInv, ago(-7)); // still valid
  const job = (id: string, state: string, finished: string | null, runAfter: string) =>
    owner.query("INSERT INTO jobs (id, organization_id, type, dedupe_key, state, attempts, run_after, finished_at, created_at) VALUES ($1, $2, 'notifications.scan_due', $3, $4, 1, $5, $6, $7)", [id, a.orgId, `seed:${id}`, state, runAfter, finished, ago(120)]);
  await job(s.oldDone, "succeeded", ago(40), ago(40));
  await job(s.oldDead, "dead", ago(31), ago(31));
  await job(s.newDone, "succeeded", ago(5), ago(5));
  await job(s.oldQueued, "queued", null, "2099-01-01T00:00:00Z"); // unfinished rows are never purged, however old
  await job(s.oldFailed, "failed", null, "2099-01-01T00:00:00Z");
  return s;
}
const exists = async (table: string, id: string) => (await owner.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount === 1;
const expectRows = async (s: Seed, list: Array<[string, keyof Seed]>, present: boolean) => {
  for (const [t, k] of list) expect(await exists(t, s[k]), `${t}.${k}`).toBe(present);
};
const counts = (body: { classes: { dataClass: string; eligible: number; deleted: number }[] }, field: "eligible" | "deleted") => Object.fromEntries(body.classes.map((c) => [c.dataClass, c[field]]));
const purgeJobs = async (orgId: string) => (await owner.query("SELECT state FROM jobs WHERE organization_id = $1 AND type = 'retention.purge' ORDER BY created_at, id", [orgId])).rows.map((r) => r.state as string);
const auditMeta = async (orgId: string, action: string) => (await owner.query("SELECT metadata FROM audit_events WHERE organization_id = $1 AND action = $2 ORDER BY created_at", [orgId, action])).rows.map((r) => r.metadata as { trigger: string; classes: { dataClass: string; deleted: number; eligible: number }[]; skipped: string[] });
const ledger = async (orgId: string) =>
  (await owner.query(
    `SELECT (SELECT count(*) FROM suppressions WHERE organization_id = $1)::int AS suppressions, (SELECT count(*) FROM consent_events WHERE organization_id = $1)::int AS consent,
            (SELECT count(*) FROM contacts WHERE organization_id = $1)::int AS contacts, (SELECT count(*) FROM privacy_requests WHERE organization_id = $1)::int AS requests`, [orgId])).rows[0] as Record<string, number>;
const auditCount = async (orgId: string) => (await owner.query("SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1", [orgId])).rows[0].n as number;

beforeAll(async () => {
  api = await startApi();
  worker = api.app.get(WorkerService);
  privacy = api.app.get(PrivacyService);
  const jobs = api.app.get(JobsService);
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
  await api.close();
});
beforeEach(() => {
  worker.config = { ...configFromEnv({}), batch: 100, metricsFile: null };
  worker.now = () => NOW;
});

describe("defaults and configuration", () => {
  it("exposes the owner-decided defaults, identical in the contract and in the database, and lets an organization change or disable a class", async () => {
    expect(RETENTION_DEFAULT_DAYS).toEqual({ sessions: 30, invitations: 30, import_jobs: 90, jobs: 30 });
    for (const c of RETENTION_CLASSES) expect((await owner.query("SELECT retention_default_days($1) AS d", [c])).rows[0].d).toBe(RETENTION_DEFAULT_DAYS[c]);
    expect((await owner.query("SELECT retention_default_days('audit_events') AS d")).rows[0].d).toBeNull();
    expect(configFromEnv({}).retentionEveryMs).toBe(DAY);

    const a = await register("ret-cfg");
    const get = await api.call("GET", "/privacy/retention", { token: a.token });
    expect(get.body.policies).toEqual([]);
    expect(get.body.effective).toEqual(RETENTION_CLASSES.map((c) => ({ dataClass: c, retentionDays: RETENTION_DEFAULT_DAYS[c], source: "default" })));

    expect((await setPolicy(a.token, [{ dataClass: "jobs", retentionDays: 29 }])).status).toBe(400); // floor still applies
    expect((await setPolicy(a.token, [{ dataClass: "suppressions", retentionDays: 90 }])).status).toBe(400); // never purgeable
    const put = await setPolicy(a.token, [{ dataClass: "sessions", retentionDays: 0 }, { dataClass: "jobs", retentionDays: 60 }]);
    expect(put.status).toBe(200);
    expect(put.body.effective).toEqual(expect.arrayContaining([
      { dataClass: "sessions", retentionDays: 0, source: "policy" }, { dataClass: "jobs", retentionDays: 60, source: "policy" }, { dataClass: "import_jobs", retentionDays: 90, source: "default" },
    ]));
    const seller = await seedMember(a.orgId, "seller");
    const sellerToken = (await api.call("POST", "/auth/login", { body: { email: seller.email, password: PASSWORD } })).body.token as string;
    expect((await api.call("POST", "/privacy/retention/run", { token: sellerToken, body: {} })).status).toBe(403);
    await expect(asRuntime({ organizationId: a.orgId, userId: seller.userId, role: "seller" }, (c) => c.query("SELECT privacy_purge('jobs', true, $1)", [NOW]))).rejects.toThrow(/org_admin required/);
  });
});

describe("dry-run", () => {
  it("returns the counts per class and deletes nothing (service with injected clock, and the HTTP endpoint)", async () => {
    const a = await register("ret-dry");
    const s = await seed(a);
    const dry = await privacy.run(ctxOf(a), true, { now: NOW });
    expect(dry).toMatchObject({ dryRun: true, ranAt: NOW.toISOString(), skipped: [] });
    expect(counts(dry, "eligible")).toEqual({ import_jobs: 1, sessions: 1, invitations: 1, jobs: 2 });
    expect(counts(dry, "deleted")).toEqual({ import_jobs: 0, sessions: 0, invitations: 0, jobs: 0 });
    expect(dry.classes.find((c) => c.dataClass === "import_jobs")).toMatchObject({ retentionDays: 90, source: "default", cutoff: ago(90) });

    const http = await api.call("POST", "/privacy/retention/run", { token: a.token, body: {} }); // dryRun is the default
    expect(http.status).toBe(200);
    expect(http.body.dryRun).toBe(true);
    expect(counts(http.body, "deleted")).toEqual({ import_jobs: 0, sessions: 0, invitations: 0, jobs: 0 });
    await expectRows(s, [...EXPIRED, ...KEPT], true);

    const meta = await auditMeta(a.orgId, "privacy.retention.dry_run");
    expect(meta).toHaveLength(2);
    expect(meta[0]?.classes.find((c) => c.dataClass === "jobs")).toMatchObject({ eligible: 2, deleted: 0 });
    expect(JSON.stringify(meta)).not.toMatch(/@|token/); // counts only, no personal data
  });
});

describe("purge", () => {
  it("deletes only what is past its term, never another organization, never the ledgers or a restricted data subject, and is idempotent", async () => {
    const a = await register("ret-run");
    const b = await register("ret-other");
    const sa = await seed(a);
    const sb = await seed(b);
    // protected data: a suppression, a consenting contact and a contact under restriction (data-subject request)
    await api.call("POST", "/suppressions", { token: a.token, body: { kind: "domain", value: `sup-${randomUUID().slice(0, 8)}.example`, reason: "pidió no ser contactado" } });
    const domain = `ret-${randomUUID().slice(0, 8)}.example`;
    const p = (await api.call("POST", "/prospects", { token: a.token, body: { name: "Co Ret", domain } })).body as { id: string };
    const c = (await api.call("POST", `/prospects/${p.id}/contacts`, { token: a.token, body: { address: `titular@${domain}`, displayName: "Ana Titular", source: "Formulario web, 2026-05-01" } })).body as { id: string };
    expect((await api.call("POST", `/contacts/${c.id}/consent`, { token: a.token, body: { event: "granted", evidence: "Casilla marcada en el formulario web", occurredAt: ago(1) } })).status).toBe(201);
    const req = await api.call("POST", "/privacy/requests", { token: a.token, body: { contactId: c.id, kind: "restrict" } });
    expect((await api.call("POST", `/privacy/requests/${req.body.id}/complete`, { token: a.token })).status).toBe(200);
    const before = await ledger(a.orgId);
    expect(before).toMatchObject({ suppressions: 1, contacts: 1, requests: 1 });
    expect(before.consent).toBeGreaterThanOrEqual(1);
    const auditBefore = await auditCount(a.orgId);

    const real = await privacy.run(ctxOf(a), false, { now: NOW });
    expect(counts(real, "deleted")).toEqual({ import_jobs: 1, sessions: 1, invitations: 1, jobs: 2 });
    await expectRows(sa, EXPIRED, false);
    await expectRows(sa, KEPT, true);
    await expectRows(sb, [...EXPIRED, ...KEPT], true); // the other organization is untouched
    expect((await api.call("GET", "/me", { token: a.token })).status).toBe(200); // the live session survives

    expect(await ledger(a.orgId)).toEqual(before);
    expect((await owner.query("SELECT status FROM contacts WHERE id = $1", [c.id])).rows[0].status).toBe("restricted");
    expect(await auditCount(a.orgId)).toBe(auditBefore + 1); // audit only grows

    const again = await privacy.run(ctxOf(a), false, { now: NOW });
    expect(counts(again, "deleted")).toEqual({ import_jobs: 0, sessions: 0, invitations: 0, jobs: 0 });
    await expectRows(sa, KEPT, true);
    const meta = await auditMeta(a.orgId, "privacy.retention.purged");
    expect(meta.map((m) => m.trigger)).toEqual(["manual", "manual"]);
    expect(JSON.stringify(meta)).not.toMatch(/@|token/);
  });

  it("a clock ahead of the real one cannot purge more than the policy allows", async () => {
    const a = await register("ret-clock");
    const res = await privacy.run(ctxOf(a), true, { now: new Date("2099-01-01T00:00:00Z") });
    expect(counts(res, "eligible")).toEqual({ import_jobs: 0, sessions: 0, invitations: 0, jobs: 0 }); // the live session of `a` would be "expired" in 2099
  });
});

describe("worker job retention.purge", () => {
  it("is planned once per organization per day, purges with the organization's own terms, skips disabled classes and audits counts", async () => {
    const def = await register("ret-wk-default");
    const off = await register("ret-wk-off");
    const own = await register("ret-wk-own");
    const [sd, so, sw] = [await seed(def), await seed(off), await seed(own)];
    expect((await setPolicy(off.token, RETENTION_CLASSES.map((c) => ({ dataClass: c, retentionDays: 0 })))).status).toBe(200);
    expect((await setPolicy(own.token, [{ dataClass: "sessions", retentionDays: 60 }, { dataClass: "jobs", retentionDays: 0 }])).status).toBe(200);

    await worker.tick();
    for (const o of [def, off, own]) expect(await purgeJobs(o.orgId)).toEqual(["succeeded"]);
    await expectRows(sd, EXPIRED, false);
    await expectRows(sd, KEPT, true);
    await expectRows(so, [...EXPIRED, ...KEPT], true); // every class disabled: nothing is purged
    await expectRows(sw, [["import_jobs", "oldImport"], ["invitations", "oldInv"]], false);
    await expectRows(sw, [["sessions", "oldSession"], ["jobs", "oldDone"], ["jobs", "oldDead"], ...KEPT], true); // 40 days < its 60-day term; jobs disabled

    const meta = await auditMeta(def.orgId, "privacy.retention.purged");
    expect(meta).toHaveLength(1);
    expect(meta[0]).toMatchObject({ trigger: "worker", skipped: [] });
    expect(Object.fromEntries(meta[0]!.classes.map((c) => [c.dataClass, c.deleted]))).toEqual({ import_jobs: 1, sessions: 1, invitations: 1, jobs: 2 });
    expect((await auditMeta(off.orgId, "privacy.retention.purged"))[0]).toMatchObject({ trigger: "worker", classes: [], skipped: [...RETENTION_CLASSES] });

    // same day, later windows: no second purge job
    worker.now = () => new Date(NOW.getTime() + 3 * 3_600_000);
    await worker.tick();
    await Promise.all([worker.plan(), worker.plan()]);
    for (const o of [def, off, own]) expect(await purgeJobs(o.orgId)).toEqual(["succeeded"]);

    // next day: one more job, which finds nothing new to delete
    worker.now = () => new Date(NOW.getTime() + DAY);
    await worker.tick();
    expect(await purgeJobs(def.orgId)).toEqual(["succeeded", "succeeded"]);
    const second = (await auditMeta(def.orgId, "privacy.retention.purged"))[1]!;
    expect(second.classes.every((c) => c.deleted === 0)).toBe(true);
    await expectRows(sd, KEPT, true);
  });

  it("is not planned when the retention window is 0, and the queue only accepts known job types", async () => {
    const a = await register("ret-wk-none");
    worker.config = { ...worker.config, retentionEveryMs: 0 };
    worker.now = () => new Date(NOW.getTime() + 10 * DAY);
    await worker.plan();
    expect(await purgeJobs(a.orgId)).toEqual([]);
    await expect(owner.query("INSERT INTO jobs (organization_id, type, dedupe_key) VALUES ($1, 'retention.everything', 'x')", [a.orgId])).rejects.toThrow(/jobs_type/);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "../auth/auth.types.js";
import { JobsService } from "../jobs/jobs.service.js";
import { configFromEnv, WorkerService } from "../jobs/worker.service.js";
import { LifecycleService } from "../prospects/lifecycle/lifecycle.service.js";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/**
 * Prospect lifecycle: monthly cohorts, lead quota, automatic transitions (lead / sequence), expiry of prospects without a lead (anonymisation that keeps
 * suppressions, consent and counts), tenant isolation and idempotency. The clock is injected (NOW) and every date is set explicitly relative to it.
 * Run with TEST_DATABASE_URL=postgresql://app:app@localhost:5432/prospecting_lifecycle_test
 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

let api: Api;
let svc: LifecycleService;
let worker: WorkerService;
type Account = { token: string; orgId: string; userId: string };
const mine = new Set<string>();

async function register(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label}` } });
  const me = await api.call("GET", "/me", { token: res.body.token });
  mine.add(res.body.organization.id as string);
  return { token: res.body.token, orgId: res.body.organization.id, userId: me.body.user.id };
}
const ctxOf = (a: Account): AuthContext => ({ sessionId: "test", userId: a.userId, organizationId: a.orgId, role: "org_admin", requestId: "test" });

async function prospect(a: Account, over: { cohort?: string; expires?: string; label?: string } = {}): Promise<string> {
  const id = randomUUID();
  const key = `acme-${id.slice(0, 8)}`;
  await owner.query(
    `INSERT INTO prospects (id, organization_id, name, name_key, domain_key, dedupe_key, website, city, notes, created_by, created_at, updated_at, cohort_month, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'https://x.example', 'Madrid', 'notas privadas', $7, $8, $8, $9, $10)`,
    [id, a.orgId, over.label ?? `Acme ${key}`, key, `${key}.example`, `${key}.example`, a.userId, at(-40), over.cohort ?? "2026-05-01", over.expires ?? at(-1)]);
  return id;
}
const state = async (id: string) => (await owner.query("SELECT lifecycle_state, closed_at, name, website, notes, city FROM prospects WHERE id = $1", [id])).rows[0] as { lifecycle_state: string; closed_at: Date | null; name: string; website: string | null; notes: string | null; city: string | null };
const contact = async (a: Account, prospectId: string, status = "active") => {
  const id = randomUUID();
  const addr = `c-${id.slice(0, 8)}@example.test`;
  await owner.query("INSERT INTO contacts (id, organization_id, prospect_id, address, address_key, source, created_by, updated_at) VALUES ($1, $2, $3, $4, $4, 'manual', $5, now())", [id, a.orgId, prospectId, addr, a.userId]);
  await owner.query("INSERT INTO consent_events (organization_id, contact_id, event, evidence, occurred_at, recorded_by) VALUES ($1, $2, 'granted', 'form signed', $3, $4)", [a.orgId, id, at(-45), a.userId]);
  if (status !== "active") await owner.query("UPDATE contacts SET status = $2 WHERE id = $1", [id, status]);
  return { id, addr };
};
const lead = async (a: Account, prospectId: string, st = "pending_review") => {
  const id = randomUUID();
  const asm = (await owner.query("INSERT INTO intent_assessments (organization_id, prospect_id, excerpt, text_hash, classifier_version, class, matched, ambiguous, created_by) VALUES ($1, $2, 'quiero precio', repeat('a', 64), 'v1', 'purchase', '[]', false, $3) RETURNING id", [a.orgId, prospectId, a.userId])).rows[0].id as string;
  await owner.query("INSERT INTO leads (id, organization_id, prospect_id, origin, state, open_key, assessment_id, created_by) VALUES ($1, $2, $3, 'intent', 'pending_review', $4, $5, $6)", [id, a.orgId, prospectId, prospectId, asm, a.userId]);
  if (st === "rejected") await owner.query("UPDATE leads SET state = 'rejected', open_key = NULL, reviewed_at = now(), reviewed_by = $2 WHERE id = $1", [id, a.userId]);
  if (st === "accepted") await owner.query("UPDATE leads SET state = 'accepted', reviewed_at = now(), reviewed_by = $2 WHERE id = $1", [id, a.userId]);
  return id;
};

beforeAll(async () => {
  api = await startApi();
  svc = api.app.get(LifecycleService);
  worker = api.app.get(WorkerService);
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

describe("defaults and transitions", () => {
  it("a new prospect is active, in the current month's cohort, expiring one month after discovery", async () => {
    const a = await register("lc-new");
    const res = await api.call("POST", "/prospects", { token: a.token, body: { name: "Nueva SL", domain: "nueva.example" } });
    expect(res.status).toBe(201);
    const r = (await owner.query("SELECT lifecycle_state, cohort_month::text AS cm, expires_at, created_at FROM prospects WHERE id = $1", [res.body.id])).rows[0];
    expect(r.lifecycle_state).toBe("active");
    expect(r.cm).toBe(`${r.created_at.toISOString().slice(0, 7)}-01`);
    expect(Math.round((r.expires_at.getTime() - r.created_at.getTime()) / DAY)).toBeGreaterThanOrEqual(28);
  });

  it("lead created or accepted converts, rejected rejects; leaving active stamps closed_at", async () => {
    const a = await register("lc-lead");
    const [p1, p2, p3] = [await prospect(a), await prospect(a), await prospect(a)];
    await lead(a, p1);
    expect((await state(p1)).lifecycle_state).toBe("converted");
    expect((await state(p1)).closed_at).not.toBeNull();
    const l2 = await lead(a, p2);
    await owner.query("UPDATE leads SET state = 'rejected', open_key = NULL, reviewed_at = now(), reviewed_by = $2 WHERE id = $1", [l2, a.userId]);
    expect((await state(p2)).lifecycle_state).toBe("rejected");
    const l3 = await lead(a, p3);
    await owner.query("UPDATE leads SET state = 'accepted', reviewed_at = now(), reviewed_by = $2 WHERE id = $1", [l3, a.userId]);
    expect((await state(p3)).lifecycle_state).toBe("converted");
  });

  it("a completed sequence (no reply) marks no_reply; a stopped one does not; a prospect with a lead is not downgraded", async () => {
    const a = await register("lc-seq");
    const camp = (await api.call("POST", "/campaigns", { token: a.token, body: { name: "Seq", subject: "s", body: "b {{unsubscribe_url}}" } })).body.id as string;
    await owner.query("INSERT INTO sequence_steps (organization_id, campaign_id, step_no, delay_hours, subject, body) VALUES ($1, $2, 1, 0, 's', 'b {{unsubscribe_url}}')", [a.orgId, camp]);
    await owner.query("UPDATE campaigns SET state = 'approved' WHERE id = $1", [camp]);
    await owner.query("UPDATE campaigns SET state = 'running' WHERE id = $1", [camp]);
    const mk = async (final: "completed" | "stopped", withLead = false) => {
      const p = await prospect(a);
      const c = await contact(a, p);
      if (withLead) await lead(a, p);
      const e = randomUUID();
      await owner.query("INSERT INTO sequence_enrollments (id, organization_id, campaign_id, contact_id, created_by, updated_at, next_due_at) VALUES ($1, $2, $3, $4, $5, now(), now())", [e, a.orgId, camp, c.id, a.userId]);
      if (final === "completed") await owner.query("UPDATE sequence_enrollments SET state = 'completed', next_due_at = NULL WHERE id = $1", [e]);
      else await owner.query("UPDATE sequence_enrollments SET state = 'stopped', stop_reason = 'opted_out', next_due_at = NULL WHERE id = $1", [e]);
      return p;
    };
    expect((await state(await mk("completed"))).lifecycle_state).toBe("no_reply");
    expect((await state(await mk("stopped"))).lifecycle_state).toBe("active");
    expect((await state(await mk("completed", true))).lifecycle_state).toBe("converted");
  });
});

describe("expiry", () => {
  it("expires only due, lead-less, active prospects; anonymises; keeps suppressions, consent, opted-out addresses and counts; is idempotent", async () => {
    const a = await register("lc-exp");
    const due = await prospect(a, { expires: at(-1), label: "Vencida SL" });
    const notDue = await prospect(a, { expires: at(10) });
    const converted = await prospect(a, { expires: at(-30) });
    await lead(a, converted);
    const rejected = await prospect(a, { expires: at(-30) });
    const lr = await lead(a, rejected);
    await owner.query("UPDATE leads SET state = 'rejected', open_key = NULL, reviewed_at = now(), reviewed_by = $2 WHERE id = $1", [lr, a.userId]);
    const cActive = await contact(a, due);
    const cOut = await contact(a, due, "opted_out");
    const cKept = await contact(a, notDue);
    const key = (await owner.query("SELECT name_key, domain_key FROM prospects WHERE id = $1", [due])).rows[0];
    await owner.query("INSERT INTO suppressions (organization_id, kind, value_key, reason, created_by) VALUES ($1, 'domain', $2, 'pidio no ser contactado', $3)", [a.orgId, key.domain_key, a.userId]);
    await owner.query("INSERT INTO prospect_attributes (organization_id, prospect_id, key, value, value_key, confidence, source, created_by) VALUES ($1, $2, 'phone', '600', '600', 'high', 'manual', $3)", [a.orgId, due, a.userId]);

    const first = await svc.expireDue(ctxOf(a), NOW);
    expect(first).toEqual({ expired: 1, contactsAnonymized: 1 });
    const d = await state(due);
    expect(d.lifecycle_state).toBe("expired");
    expect([d.name, d.website, d.notes, d.city]).toEqual(["[expired]", null, null, null]);
    expect((await state(notDue)).lifecycle_state).toBe("active");
    expect((await state(converted)).lifecycle_state).toBe("converted");
    expect((await state(converted)).name).not.toBe("[expired]");
    expect((await state(rejected)).lifecycle_state).toBe("rejected");
    const attrs = await owner.query("SELECT 1 FROM prospect_attributes WHERE prospect_id = $1", [due]);
    expect(attrs.rowCount).toBe(0);
    // contacts: active anonymised, opted-out address kept (do-not-contact record), other prospect untouched
    expect((await owner.query("SELECT address FROM contacts WHERE id = $1", [cActive.id])).rows[0].address).toMatch(/@expired\.invalid$/);
    expect((await owner.query("SELECT address FROM contacts WHERE id = $1", [cOut.id])).rows[0].address).toBe(cOut.addr);
    expect((await owner.query("SELECT address FROM contacts WHERE id = $1", [cKept.id])).rows[0].address).toBe(cKept.addr);
    // suppression list and consent ledger survive
    expect((await owner.query("SELECT 1 FROM suppressions WHERE organization_id = $1 AND value_key = $2", [a.orgId, key.domain_key])).rowCount).toBe(1);
    expect((await owner.query("SELECT 1 FROM consent_events WHERE contact_id = $1", [cActive.id])).rowCount).toBe(1);
    // audit + idempotent retry
    expect((await owner.query("SELECT 1 FROM audit_events WHERE organization_id = $1 AND action = 'prospects.expired'", [a.orgId])).rowCount).toBe(1);
    expect(await svc.expireDue(ctxOf(a), NOW)).toEqual({ expired: 0, contactsAnonymized: 0 });
    expect((await owner.query("SELECT 1 FROM audit_events WHERE organization_id = $1 AND action = 'prospects.expired'", [a.orgId])).rowCount).toBe(1);
  });

  it("a prospect that has a lead in any state is never expired, even past its month", async () => {
    const a = await register("lc-nolead");
    const p = await prospect(a, { expires: at(-60) });
    await lead(a, p, "pending_review");
    await owner.query("UPDATE prospects SET lifecycle_state = 'active' WHERE id = $1", [p]); // force it back to active: the lead alone must protect it
    expect((await svc.expireDue(ctxOf(a), NOW)).expired).toBe(0);
    expect((await state(p)).name).not.toBe("[expired]");
  });

  it("is tenant-scoped: expiring organization A never touches B, and only org_admin may run it in the database", async () => {
    const a = await register("lc-iso-a");
    const b = await register("lc-iso-b");
    const pa = await prospect(a);
    const pb = await prospect(b);
    expect((await svc.expireDue(ctxOf(a), NOW)).expired).toBe(1);
    expect((await state(pa)).lifecycle_state).toBe("expired");
    expect((await state(pb)).lifecycle_state).toBe("active");
    const sales = await seedMember(a.orgId, "sales_manager");
    await expect(asRuntime({ organizationId: a.orgId, userId: sales.userId, role: "sales_manager" }, (c) => c.query("SELECT prospects_expire_due()"))).rejects.toThrow(/org_admin required/);
    await expect(asRuntime({ userId: a.userId, role: "org_admin" }, (c) => c.query("SELECT prospects_expire_due()"))).rejects.toThrow(/org_admin required/);
  });

  it("the worker job expires due prospects once per day window and a retry is harmless", async () => {
    const a = await register("lc-wk");
    const p = await prospect(a);
    await worker.tick();
    expect((await state(p)).lifecycle_state).toBe("expired");
    const jobs = await owner.query("SELECT state FROM jobs WHERE organization_id = $1 AND type = 'prospects.expire_due'", [a.orgId]);
    expect(jobs.rows.map((r) => r.state)).toEqual(["succeeded"]);
    await worker.tick(); // same day window: not planned again
    expect((await owner.query("SELECT 1 FROM jobs WHERE organization_id = $1 AND type = 'prospects.expire_due'", [a.orgId])).rowCount).toBe(1);
  });
});

describe("cohorts and quota", () => {
  it("groups by discovery month with counts per state, quota and percent used", async () => {
    const a = await register("lc-coh");
    const may = ["active", "converted", "rejected", "no_reply", "expired", "converted"] as const;
    for (const s of may) {
      const p = await prospect(a, { cohort: "2026-05-01", expires: at(10) });
      await owner.query("UPDATE prospects SET lifecycle_state = $2 WHERE id = $1", [p, s]);
    }
    await prospect(a, { cohort: "2026-06-01", expires: at(10) });
    expect((await api.call("GET", "/prospects/cohorts", { token: a.token })).body).toEqual({ monthlyLeadQuota: null, items: [
      { month: "2026-06", discovered: 1, active: 1, converted: 0, rejected: 0, noReply: 0, expired: 0, monthlyLeadQuota: null, quotaUsedPercent: null },
      { month: "2026-05", discovered: 6, active: 1, converted: 2, rejected: 1, noReply: 1, expired: 1, monthlyLeadQuota: null, quotaUsedPercent: null },
    ] });
    const put = await api.call("PUT", "/prospects/lead-quota", { token: a.token, body: { monthlyLeadQuota: 8 } });
    expect(put.status).toBe(200);
    expect(put.body.monthlyLeadQuota).toBe(8);
    const res = await api.call("GET", "/prospects/cohorts", { token: a.token });
    expect(res.body.items[1]).toMatchObject({ month: "2026-05", monthlyLeadQuota: 8, quotaUsedPercent: 25 });
    expect((await api.call("PUT", "/prospects/lead-quota", { token: a.token, body: { monthlyLeadQuota: 0 } })).body.monthlyLeadQuota).toBe(0);
    expect((await api.call("GET", "/prospects/cohorts", { token: a.token })).body.items[1].quotaUsedPercent).toBeNull();
    expect((await api.call("PUT", "/prospects/lead-quota", { token: a.token, body: { monthlyLeadQuota: -1 } })).status).toBe(400);
  });

  it("cohorts and quota are isolated per tenant; only org_admin sets the quota; the table is forced RLS", async () => {
    const a = await register("lc-q-a");
    const b = await register("lc-q-b");
    await prospect(a, { expires: at(10) });
    expect((await api.call("PUT", "/prospects/lead-quota", { token: a.token, body: { monthlyLeadQuota: 5 } })).status).toBe(200);
    const rb = await api.call("GET", "/prospects/cohorts", { token: b.token });
    expect(rb.body).toEqual({ monthlyLeadQuota: null, items: [] });
    expect((await api.call("GET", "/prospects/lead-quota", { token: b.token })).body.monthlyLeadQuota).toBeNull();
    const viewer = await seedMember(a.orgId, "viewer");
    const login = await api.call("POST", "/auth/login", { body: { email: viewer.email, password: PASSWORD } });
    expect((await api.call("PUT", "/prospects/lead-quota", { token: login.body.token, body: { monthlyLeadQuota: 99 } })).status).toBe(403);
    // database level: another tenant's session and a non-admin role cannot write or read the row
    await expect(asRuntime({ organizationId: b.orgId, userId: b.userId, role: "org_admin" }, (c) => c.query("INSERT INTO lead_quotas (organization_id, monthly_lead_quota, updated_by) VALUES ($1, 1, $2)", [a.orgId, b.userId]))).rejects.toThrow();
    const seen = await asRuntime({ organizationId: b.orgId, userId: b.userId, role: "org_admin" }, (c) => c.query("SELECT * FROM lead_quotas"));
    expect(seen.rowCount).toBe(0);
    await expect(asRuntime({ organizationId: a.orgId, userId: viewer.userId, role: "viewer" }, (c) => c.query("INSERT INTO lead_quotas (organization_id, monthly_lead_quota, updated_by) VALUES ($1, 1, $2) ON CONFLICT (organization_id) DO UPDATE SET monthly_lead_quota = 1", [a.orgId, viewer.userId]))).rejects.toThrow();
    const f = await owner.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'lead_quotas'");
    expect(f.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});

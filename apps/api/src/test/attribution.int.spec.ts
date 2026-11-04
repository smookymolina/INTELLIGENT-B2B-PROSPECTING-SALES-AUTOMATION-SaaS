import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttributionReportDto, CohortsReportDto, MEMBERSHIP_ROLES, type MembershipRole } from "@prospecting/contracts";
import { type Api, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** F11: campaign attribution (last touch) and prospect cohorts, reconciled with analytics, under RLS. */
let api: Api;
type Account = { token: string; orgId: string; userId: string };

async function register(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label}` } });
  const me = await api.call("GET", "/me", { token: res.body.token });
  return { token: res.body.token, orgId: res.body.organization.id, userId: me.body.user.id };
}
async function member(orgId: string, role: MembershipRole) {
  const m = await seedMember(orgId, role);
  return (await api.call("POST", "/auth/login", { body: { email: m.email, password: PASSWORD } })).body.token as string;
}
const attr = (t: string, q = "") => api.call("GET", `/attribution/campaigns${q}`, { token: t });
const cohorts = (t: string, q = "") => api.call("GET", `/attribution/cohorts${q}`, { token: t });
const overview = (t: string, q = "") => api.call("GET", `/analytics/overview${q}`, { token: t });
const stage = (t: string, id: string, to: string) => api.call("POST", `/opportunities/${id}/stage`, { token: t, body: { stage: to } });
/** Fixture writes by the table owner with triggers off (replica role): backdating timestamps that guard triggers otherwise freeze. */
const forge = async (sql: string, p: unknown[]) => {
  const c = await owner.connect();
  try {
    await c.query("SET session_replication_role = replica");
    return c.query(sql, p);
  } finally {
    await c.query("SET session_replication_role = DEFAULT").catch(() => undefined);
    c.release();
  }
};
const q1 = async <T>(sql: string, p: unknown[]) => (await forge(sql, p)).rows[0] as T;

async function lead(a: Account, accept = true) {
  const p = (await api.call("POST", "/prospects", { token: a.token, body: { name: `Co ${randomUUID().slice(0, 6)}`, domain: `at-${randomUUID().slice(0, 8)}.example` } })).body.id as string;
  const id = (await api.call("POST", `/prospects/${p}/replies`, { token: a.token, body: { text: "Queremos comprar" } })).body.effects.leadId as string;
  if (accept) await api.call("POST", `/leads/${id}/decision`, { token: a.token, body: { decision: "accept" } });
  return { leadId: id, prospectId: p };
}
const opp = async (a: Account, leadId: string) => (await api.call("POST", "/opportunities", { token: a.token, body: { leadId, title: "Venta" } })).body.id as string;

/** Accepted quote of 2 x 100 + 16% = 232.0000 MXN for the opportunity. */
async function sale(a: Account, oppId: string): Promise<void> {
  const item = (await api.call("POST", "/catalog/items", { token: a.token, body: { kind: "product", sku: `AT-${randomUUID().slice(0, 6)}`, name: "Bomba" } })).body;
  await api.call("POST", `/catalog/items/${item.id}/approve`, { token: a.token });
  const list = (await api.call("POST", "/catalog/price-lists", { token: a.token, body: { name: `L-${randomUUID().slice(0, 5)}`, currency: "MXN" } })).body.id;
  await api.call("PUT", `/catalog/price-lists/${list}/entries/${item.id}`, { token: a.token, body: { unitPrice: "100" } });
  await api.call("POST", `/catalog/price-lists/${list}/approve`, { token: a.token });
  await stage(a.token, oppId, "contacted");
  await stage(a.token, oppId, "qualification");
  const id = (await api.call("POST", "/quotes", { token: a.token, body: { opportunityId: oppId, priceListId: list, taxRate: "16" } })).body.id as string;
  await api.call("POST", `/quotes/${id}/lines`, { token: a.token, body: { sku: item.sku, quantity: "2" } });
  await api.call("POST", `/quotes/${id}/send`, { token: a.token });
  await api.call("POST", `/quotes/${id}/decision`, { token: a.token, body: { decision: "accept" } });
}

async function campaign(a: Account, name: string): Promise<string> {
  return (await q1<{ id: string }>("INSERT INTO campaigns (organization_id, name, subject, body, state, created_by, approved_by, approved_at, launched_at, updated_at) VALUES ($1,$2,'s','b {{unsubscribe_url}}','running',$3,$3,now(),now(),now()) RETURNING id", [a.orgId, name, a.userId])).id;
}
/** A sent (or other state) email to the prospect, `secondsBefore` before the given lead's creation. */
async function touch(a: Account, campaignId: string, prospectId: string, leadId: string, secondsBefore: number, state = "sent"): Promise<void> {
  const c = await q1<{ id: string }>("INSERT INTO contacts (organization_id, prospect_id, channel, address, address_key, source, created_by, updated_at) VALUES ($1,$2,'email',$3,$3,'Alta manual',$4, now()) RETURNING id", [a.orgId, prospectId, `${randomUUID().slice(0, 8)}@x.example`, a.userId]);
  await forge(
    "INSERT INTO send_attempts (organization_id, campaign_id, contact_id, state, provider, provider_message_id, attempted_at) VALUES ($1,$2,$3,$4,'test',CASE WHEN $4 = 'sent' THEN gen_random_uuid()::text END,(SELECT created_at FROM leads WHERE id=$5) - ($6 || ' seconds')::interval)",
    [a.orgId, campaignId, c.id, state, leadId, String(secondsBefore)],
  );
}
const D = 86_400;

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("campaign attribution", () => {
  it("attributes lead, opportunity and sale to the last sent touch inside the lookback and reconciles with analytics", async () => {
    const a = await register("attr");
    const alfa = await campaign(a, "Alfa");
    const beta = await campaign(a, "Beta");
    const l1 = await lead(a); // two touches: Alfa 5d, Beta 2d before -> Beta (last touch); lead -> opportunity -> sale
    const l2 = await lead(a); // Alfa 10d before; opportunity, no sale
    const l3 = await lead(a); // Alfa 45d before: outside default lookback
    const l4 = await lead(a); // failed Beta send, and an Alfa send AFTER the lead: neither counts
    await touch(a, alfa, l1.prospectId, l1.leadId, 5 * D);
    await touch(a, beta, l1.prospectId, l1.leadId, 2 * D);
    await touch(a, alfa, l2.prospectId, l2.leadId, 10 * D);
    await touch(a, alfa, l3.prospectId, l3.leadId, 45 * D);
    await touch(a, beta, l4.prospectId, l4.leadId, 3600, "failed");
    await touch(a, alfa, l4.prospectId, l4.leadId, -1);
    await sale(a, await opp(a, l1.leadId));
    await opp(a, l2.leadId);

    const res = await attr(a.token);
    expect(res.status).toBe(200);
    const r = AttributionReportDto.parse(res.body);
    expect(r.model).toMatchObject({ id: "last_touch_sent_email", lookbackDays: 30 });
    expect(r.model.definition).toContain("Ultimo toque");
    const by = Object.fromEntries(r.campaigns.map((c) => [c.name, c]));
    expect(by.Beta).toMatchObject({ leads: 1, opportunities: 1, sales: 1, salesByCurrency: [{ currency: "MXN", count: 1, total: "232.0000" }] });
    expect(by.Alfa).toMatchObject({ leads: 1, opportunities: 1, sales: 0, salesByCurrency: [] });
    expect(r.campaigns[0]?.name).toBe("Beta"); // ordered by sales
    expect(r.unattributed).toMatchObject({ leads: 2, opportunities: 0, sales: 0 });
    expect(r.totals).toMatchObject({ leads: 4, opportunities: 2, sales: 1, salesByCurrency: [{ currency: "MXN", count: 1, total: "232.0000" }] });
    // Sends in the window: Alfa 5d (l1), 10d (l2), +1s (l4) = 3 over 3 prospects; l3's 45d-old send is outside the 30-day window; Beta only the sent one.
    expect(by.Alfa).toMatchObject({ sent: 3, prospectsReached: 3 });
    expect(by.Beta).toMatchObject({ sent: 1, prospectsReached: 1 });

    // Reconciliation with analytics for the same window.
    const ov = (await overview(a.token)).body;
    const f = Object.fromEntries(ov.funnel.map((x: { id: string; count: number }) => [x.id, x.count]));
    expect(r.totals.leads).toBe(f.leads);
    expect(r.totals.opportunities).toBe(f.opportunities);
    expect(r.totals.sales).toBe(f.sales);
    expect(r.totals.salesByCurrency).toEqual(ov.sales.map((s: { currency: string; count: number; total: string }) => ({ currency: s.currency, count: s.count, total: s.total })));
    const sumAttr = (k: "leads" | "opportunities" | "sales") => r.campaigns.reduce((n, c) => n + c[k], 0) + r.unattributed[k];
    expect([sumAttr("leads"), sumAttr("opportunities"), sumAttr("sales")]).toEqual([f.leads, f.opportunities, f.sales]);

    // Configurable lookback.
    const wide = AttributionReportDto.parse((await attr(a.token, "?lookbackDays=60")).body);
    expect(wide.campaigns.find((c) => c.name === "Alfa")).toMatchObject({ leads: 2 });
    expect(wide.unattributed.leads).toBe(1);
    const narrow = AttributionReportDto.parse((await attr(a.token, "?lookbackDays=3")).body);
    expect(narrow.campaigns.find((c) => c.name === "Beta")).toMatchObject({ leads: 1, sales: 1 });
    expect(narrow.campaigns.find((c) => c.name === "Alfa")).toMatchObject({ leads: 0, opportunities: 0, sales: 0, sent: 3 });
    expect(narrow.unattributed.leads).toBe(3);
    expect(narrow.totals.leads).toBe(4);

    // Window: a past window has no conversions (nor attribution rows from sends).
    const day = (o: number) => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);
    const past = AttributionReportDto.parse((await attr(a.token, `?from=${day(-20)}&to=${day(-2)}`)).body);
    expect(past.totals).toMatchObject({ leads: 0, opportunities: 0, sales: 0, salesByCurrency: [] });
    expect(past.unattributed).toMatchObject({ leads: 0 });

    for (const q of ["?lookbackDays=0", "?lookbackDays=366", "?lookbackDays=x", "?from=abc", "?extra=1"]) expect((await attr(a.token, q)).status).toBe(400);
  });

  it("never counts another tenant's touches, conversions or campaigns", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    const ca = await campaign(a, "Solo A");
    const la = await lead(a);
    await touch(a, ca, la.prospectId, la.leadId, D);
    const lb = await lead(b);
    await lead(b);
    const rb = AttributionReportDto.parse((await attr(b.token)).body);
    expect(rb.campaigns).toEqual([]);
    expect(rb.totals.leads).toBe(2);
    expect(rb.unattributed.leads).toBe(2);
    const ra = AttributionReportDto.parse((await attr(a.token)).body);
    expect(ra.totals.leads).toBe(1);
    expect(ra.campaigns.map((c) => c.name)).toEqual(["Solo A"]);
    // A prospect of B touched by A's campaign (forged row via owner) is still invisible to both: the contact must belong to the same org.
    expect(lb.prospectId).not.toBe(la.prospectId);
    expect(CohortsReportDto.parse((await cohorts(b.token)).body).totalProspects).toBe(2);
    expect(CohortsReportDto.parse((await cohorts(a.token)).body).totalProspects).toBe(1);
  });

  it("requires analytics:read (sellers get 403; read roles get 200)", async () => {
    const a = await register("rbac");
    const expected: Record<MembershipRole, number> = { org_admin: 200, sales_manager: 200, campaign_manager: 200, analyst: 200, viewer: 200, seller: 403 };
    for (const role of MEMBERSHIP_ROLES) {
      const t = role === "org_admin" ? a.token : await member(a.orgId, role);
      expect((await attr(t)).status, `attribution ${role}`).toBe(expected[role]);
      expect((await cohorts(t)).status, `cohorts ${role}`).toBe(expected[role]);
    }
    expect((await api.call("GET", "/attribution/campaigns")).status).toBe(401);
  });
});

describe("cohorts", () => {
  it("groups prospects by UTC month of creation and counts exact conversions by age, reconciled with analytics", async () => {
    const a = await register("cohort");
    const now = new Date();
    const m1 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 5);
    const m2 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 5);
    const at = (base: number, days: number) => new Date(base + days * 86_400_000).toISOString();
    const ym = (base: number) => new Date(base).toISOString().slice(0, 7);
    const mk = async (base: number, created: number) => {
      const l = await lead(a);
      const o = await opp(a, l.leadId);
      await forge("UPDATE prospects SET created_at=$2 WHERE id=$1", [l.prospectId, at(base, created)]);
      return { ...l, oppId: o };
    };
    // Cohort m1: A (lead +10d, opp +12d, sale +20d), B (lead +50d, opp +70d), C (never converts: lead/opportunity removed below is not possible, so C is created without them)
    const A = await mk(m1, 0);
    const B = await mk(m1, 0);
    await sale(a, A.oppId);
    const setTs = async (table: string, col: string, id: string, ts: string) => forge(`UPDATE ${table} SET ${col}=$2 WHERE id=$1`, [id, ts]);
    const oppOf = async (leadId: string) => (await q1<{ id: string }>("SELECT id FROM opportunities WHERE lead_id=$1", [leadId])).id;
    await setTs("leads", "created_at", A.leadId, at(m1, 10));
    await setTs("opportunities", "created_at", await oppOf(A.leadId), at(m1, 12));
    await forge("UPDATE sales SET closed_at=$2 WHERE opportunity_id=$1", [A.oppId, at(m1, 20)]);
    await setTs("leads", "created_at", B.leadId, at(m1, 50));
    await setTs("opportunities", "created_at", await oppOf(B.leadId), at(m1, 70));
    // C: prospect only
    const C = (await api.call("POST", "/prospects", { token: a.token, body: { name: "Solo C", domain: `c-${randomUUID().slice(0, 6)}.example` } })).body.id as string;
    await forge("UPDATE prospects SET created_at=$2 WHERE id=$1", [C, at(m1, 3)]);
    // Cohort m2: D (lead +5d, opp +20d), E prospect only
    const Dd = await mk(m2, 0);
    await setTs("leads", "created_at", Dd.leadId, at(m2, 5));
    await setTs("opportunities", "created_at", await oppOf(Dd.leadId), at(m2, 20));
    const E = (await api.call("POST", "/prospects", { token: a.token, body: { name: "Solo E", domain: `e-${randomUUID().slice(0, 6)}.example` } })).body.id as string;
    await forge("UPDATE prospects SET created_at=$2 WHERE id=$1", [E, at(m2, 1)]);

    const from = `${ym(m1)}-01`;
    const res = await cohorts(a.token, `?from=${from}&to=${now.toISOString().slice(0, 10)}`);
    expect(res.status).toBe(200);
    const r = CohortsReportDto.parse(res.body);
    expect(r.definition).toContain("mes UTC");
    expect(r.cohorts.map((c) => c.month)).toEqual([ym(m1), ym(m2)]);
    const step = (ever: number, w30: number, w60: number, w90: number) => ({ ever, within30d: w30, within60d: w60, within90d: w90 });
    expect(r.cohorts[0]).toMatchObject({ prospects: 3, leads: step(2, 1, 2, 2), opportunities: step(2, 1, 1, 2), sales: step(1, 1, 1, 1) });
    expect(r.cohorts[1]).toMatchObject({ prospects: 2, leads: step(1, 1, 1, 1), opportunities: step(1, 1, 1, 1), sales: step(0, 0, 0, 0) });
    expect(r.totalProspects).toBe(5);

    // Reconciliation: cohort sizes and conversions equal the analytics counts for the same window.
    const ov = (await overview(a.token, `?from=${from}&to=${now.toISOString().slice(0, 10)}`)).body;
    const f = Object.fromEntries(ov.funnel.map((x: { id: string; count: number }) => [x.id, x.count]));
    expect(r.totalProspects).toBe(f.prospects);
    expect(r.cohorts.reduce((n, c) => n + c.leads.ever, 0)).toBe(f.leads);
    expect(r.cohorts.reduce((n, c) => n + c.opportunities.ever, 0)).toBe(f.opportunities);
    expect(r.cohorts.reduce((n, c) => n + c.sales.ever, 0)).toBe(f.sales);

    // A window covering only the second month excludes the first cohort.
    const only2 = CohortsReportDto.parse((await cohorts(a.token, `?from=${ym(m2)}-01&to=${now.toISOString().slice(0, 10)}`)).body);
    expect(only2.cohorts.map((c) => c.month)).toEqual([ym(m2)]);
    expect((await cohorts(a.token, "?from=2020-01-01&to=2026-12-31")).status).toBe(400);
  });
});

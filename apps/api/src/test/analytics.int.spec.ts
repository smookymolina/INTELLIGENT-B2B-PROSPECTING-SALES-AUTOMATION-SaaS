import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnalyticsOverviewDto, MEMBERSHIP_ROLES, type MembershipRole } from "@prospecting/contracts";
import { type Api, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** P11-01: analytics computed from business records under RLS, with definitions, drill-down and reconciliation. */
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
  return { token: (await api.call("POST", "/auth/login", { body: { email: m.email, password: PASSWORD } })).body.token as string, userId: m.userId };
}
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const overview = (t: string, q = "") => api.call("GET", `/analytics/overview${q}`, { token: t });
const stage = (t: string, id: string, to: string, extra: Record<string, unknown> = {}) => api.call("POST", `/opportunities/${id}/stage`, { token: t, body: { stage: to, ...extra } });

async function prospect(t: string) {
  return (await api.call("POST", "/prospects", { token: t, body: { name: `Co ${randomUUID().slice(0, 6)}`, domain: `an-${randomUUID().slice(0, 8)}.example` } })).body.id as string;
}
async function lead(t: string, decision?: "accept" | "reject") {
  const p = await prospect(t);
  const id = (await api.call("POST", `/prospects/${p}/replies`, { token: t, body: { text: "Queremos comprar" } })).body.effects.leadId as string;
  if (decision) await api.call("POST", `/leads/${id}/decision`, { token: t, body: { decision } });
  return id;
}
const opp = async (t: string, leadId: string) => (await api.call("POST", "/opportunities", { token: t, body: { leadId, title: "Venta" } })).body.id as string;

/** Builds a known scenario and returns the ids needed for assertions. */
async function scenario(a: Account) {
  const wonLead = await lead(a.token, "accept");
  const lostLead = await lead(a.token, "accept");
  await lead(a.token); // pending
  await lead(a.token, "reject");
  const won = await opp(a.token, wonLead);
  const lost = await opp(a.token, lostLead);
  await stage(a.token, lost, "contacted");
  await stage(a.token, lost, "lost", { lossReason: "precio" });

  const item = (await api.call("POST", "/catalog/items", { token: a.token, body: { kind: "product", sku: `AN-${randomUUID().slice(0, 6)}`, name: "Bomba" } })).body;
  await api.call("POST", `/catalog/items/${item.id}/approve`, { token: a.token });
  const list = (await api.call("POST", "/catalog/price-lists", { token: a.token, body: { name: `L-${randomUUID().slice(0, 5)}`, currency: "MXN" } })).body.id;
  await api.call("PUT", `/catalog/price-lists/${list}/entries/${item.id}`, { token: a.token, body: { unitPrice: "100" } });
  await api.call("POST", `/catalog/price-lists/${list}/approve`, { token: a.token });
  await stage(a.token, won, "contacted");
  await stage(a.token, won, "qualification");
  const quote = async (qty: string) => {
    const id = (await api.call("POST", "/quotes", { token: a.token, body: { opportunityId: won, priceListId: list, taxRate: "16" } })).body.id as string;
    await api.call("POST", `/quotes/${id}/lines`, { token: a.token, body: { sku: item.sku, quantity: qty } });
    await api.call("POST", `/quotes/${id}/send`, { token: a.token });
    return id;
  };
  const cancelled = await quote("1");
  const accepted = await quote("2"); // 2 x 100 + 16% = 232.0000
  await api.call("POST", `/quotes/${accepted}/decision`, { token: a.token, body: { decision: "accept" } });
  await api.call("POST", `/quotes/${cancelled}/decision`, { token: a.token, body: { decision: "cancel" } });
  return { won, lost, accepted, cancelled };
}

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("overview", () => {
  it("reports the funnel, outcomes, sales and their reconciliation with every definition", async () => {
    const a = await register("overview");
    const ids = await scenario(a);
    const res = await overview(a.token);
    expect(res.status).toBe(200);
    expect(AnalyticsOverviewDto.safeParse(res.body).success).toBe(true);
    const o = res.body as AnalyticsOverviewDto;
    expect(o.window).toEqual({ from: day(-29), to: day(0), timezone: "UTC" });
    expect(o.definitions.map((d) => d.id)).toEqual(expect.arrayContaining(["prospects", "sla", "win_rate", "reconciliation", "window"]));
    expect(o.definitions.every((d) => d.definition.length > 20)).toBe(true);

    expect(o.funnel.map((f) => [f.id, f.count, f.conversionFromPrevious])).toEqual([
      ["prospects", 4, null], ["leads", 4, 1], ["leads_accepted", 2, 0.5], ["opportunities", 2, 1], ["quotes_sent", 2, 1], ["sales", 1, 0.5],
    ]);
    expect(o.leads).toEqual({ byOrigin: { intent: 4 }, byState: { accepted: 2, pending_review: 1, rejected: 1 } });
    expect(o.pipeline).toEqual({ stages: { won: 1, lost: 1 }, open: 0 });
    expect(o.outcomes).toEqual({ won: 1, lost: 1, winRate: 0.5, lostReasons: [{ reason: "precio", count: 1 }] });
    expect(o.sales).toEqual([{ currency: "MXN", count: 1, total: "232.0000", average: "232.0000" }]);
    expect(o.reconciliation).toEqual([{ currency: "MXN", salesTotal: "232.0000", quotesTotal: "232.0000", matches: true }]);
    expect(o.sla).toEqual({ measured: 0, breached: 0, breachRate: null, avgFirstResponseMinutes: null }); // no SLA configured: nothing is measured or invented
    const t = (from: string | null, to: string) => o.transitions.find((x) => x.from === from && x.to === to)?.count;
    expect([t(null, "new"), t("new", "contacted"), t("contacted", "qualification"), t("qualification", "quote_sent"), t("quote_sent", "won"), t("contacted", "lost")]).toEqual([2, 2, 1, 1, 1, 1]);
    expect(ids.won).toBeTruthy();
  });

  it("windows are inclusive UTC days: outside the window nothing counts, and bad windows are rejected", async () => {
    const a = await register("window");
    await scenario(a);
    const past = (await overview(a.token, `?from=${day(-10)}&to=${day(-1)}`)).body as AnalyticsOverviewDto;
    expect(past.funnel.every((f) => f.count === 0)).toBe(true);
    expect(past.funnel.every((f) => f.conversionFromPrevious === null)).toBe(true);
    expect(past.sales).toEqual([]);
    expect(past.outcomes).toMatchObject({ won: 0, lost: 0, winRate: null });
    expect(past.pipeline.stages).toEqual({ won: 1, lost: 1 }); // the pipeline is "as of now", not windowed
    const today = (await overview(a.token, `?from=${day(0)}&to=${day(0)}`)).body as AnalyticsOverviewDto;
    expect(today.funnel[0]?.count).toBe(4);
    expect((await overview(a.token, `?from=${day(1)}&to=${day(5)}`)).body.funnel[0].count).toBe(0);

    for (const q of [`?from=${day(0)}&to=${day(-1)}`, `?from=${day(-400)}&to=${day(0)}`, "?from=2026-13-40", "?from=abc", "?window=30", "?from=2026-01-01&to=2027-01-02"]) {
      expect((await overview(a.token, q)).status).toBe(400);
    }
    expect((await overview(a.token, `?from=2026-01-01&to=2026-12-31`)).status).toBe(200); // 365 days apart is allowed
  });

  it("measures the first-response SLA only where a deadline exists", async () => {
    const a = await register("sla");
    const seller = await member(a.orgId, "seller");
    await api.call("PUT", `/routing/pool/${seller.userId}`, { token: a.token, body: { active: true, maxOpen: 10 } });
    await api.call("PUT", "/routing/settings", { token: a.token, body: { strategy: "round_robin", firstResponseSlaMinutes: 30 } });
    const onTime = await opp(a.token, await lead(a.token, "accept"));
    const late = await opp(a.token, await lead(a.token, "accept"));
    await stage(seller.token, onTime, "contacted");
    await owner.query("UPDATE opportunities SET first_response_due_at = now() - interval '2 hours' WHERE id = $1", [late]);
    const sla = ((await overview(a.token)).body as AnalyticsOverviewDto).sla;
    expect(sla).toMatchObject({ measured: 2, breached: 1, breachRate: 0.5 });
    expect(sla.avgFirstResponseMinutes).toBeGreaterThanOrEqual(0);
    expect(sla.avgFirstResponseMinutes).toBeLessThan(5);
  });
});

describe("drill-down", () => {
  it("lists the exact records behind each metric, paginated", async () => {
    const a = await register("drill");
    const ids = await scenario(a);
    const events = async (metric: string, extra = "") => (await api.call("GET", `/analytics/events?metric=${metric}${extra}`, { token: a.token })).body as { items: Array<{ id: string; type: string; title: string; path: string | null }>; nextCursor: string | null };

    const sales = await events("sales_closed");
    expect(sales.items).toHaveLength(1);
    expect(sales.items[0]).toMatchObject({ type: "sale", path: `/quotes/${ids.accepted}` });
    expect(sales.items[0]?.title).toContain("232.0000 MXN");
    expect((await events("opportunities_lost")).items.map((e) => e.id)).toEqual([ids.lost]);
    expect((await events("opportunities_created")).items.map((e) => e.id).sort()).toEqual([ids.won, ids.lost].sort());
    expect((await events("quotes_sent")).items.map((e) => e.id).sort()).toEqual([ids.accepted, ids.cancelled].sort());
    expect((await events("leads_created")).items).toHaveLength(4);

    const all = (await events("prospects_created")).items.map((e) => e.id);
    expect(all).toHaveLength(4);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 5; guard++) {
      const page = await events("prospects_created", `&limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect([...seen].sort()).toEqual([...all].sort());
    expect((await events("prospects_created", `&from=${day(-10)}&to=${day(-1)}`)).items).toEqual([]);
    for (const q of ["?metric=bogus", "", "?metric=sales_closed&limit=0", "?metric=sales_closed&cursor=zzz", "?metric=sales_closed&extra=1"]) {
      expect((await api.call("GET", `/analytics/events${q}`, { token: a.token })).status).toBe(400);
    }
  });
});

describe("access and isolation", () => {
  const expected: Record<MembershipRole, number> = { org_admin: 200, sales_manager: 200, campaign_manager: 200, analyst: 200, viewer: 200, seller: 403 };
  it("covers every role", () => expect(Object.keys(expected).sort()).toEqual([...MEMBERSHIP_ROLES].sort()));

  it.each(MEMBERSHIP_ROLES)("%s", async (role) => {
    const a = await register(`rbac-${role}`);
    const token = role === "org_admin" ? a.token : (await member(a.orgId, role)).token;
    expect((await overview(token)).status).toBe(expected[role]);
    expect((await api.call("GET", "/analytics/events?metric=prospects_created", { token })).status).toBe(expected[role]);
  });

  it("requires a session and never mixes tenants", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    await scenario(a);
    expect((await api.call("GET", "/analytics/overview")).status).toBe(401);
    const mine = (await overview(b.token)).body as AnalyticsOverviewDto;
    expect(mine.funnel.every((f) => f.count === 0)).toBe(true);
    expect(mine.sales).toEqual([]);
    expect(mine.reconciliation).toEqual([]);
    expect(mine.pipeline.stages).toEqual({});
    expect((await api.call("GET", "/analytics/events?metric=sales_closed", { token: b.token })).body.items).toEqual([]);
    expect((await api.call("GET", `/analytics/events?metric=prospects_created&organization_id=${a.orgId}`, { token: b.token })).status).toBe(400);
  });
});

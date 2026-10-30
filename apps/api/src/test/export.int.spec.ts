import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MembershipRole } from "@prospecting/contracts";
import { type Api, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** P11-02: CSV exports are formula-safe, scoped to the tenant and role, capped, and audited. */
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
const raw = async (path: string, token?: string) => {
  const res = await fetch(`${await api.app.getUrl()}/v1${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, text: await res.text(), headers: res.headers };
};

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("prospects export", () => {
  it("neutralises formulas, quotes awkward values, filters, and audits the export", async () => {
    const a = await register("exp-prospects");
    const evil = "=HYPERLINK(\"http://evil.example\",\"click\")";
    await api.call("POST", "/prospects", { token: a.token, body: { name: evil, domain: `exp-${randomUUID().slice(0, 6)}.example`, country: "MX" } });
    await api.call("POST", "/prospects", { token: a.token, body: { name: 'Acme, "Norte" S.A.', country: "US" } });
    await api.call("POST", "/prospects", { token: a.token, body: { name: "@cmd Company", domain: `at-${randomUUID().slice(0, 6)}.example` } });

    const res = await raw("/prospects/export", a.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="prospects.csv"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-export-truncated")).toBe("false");
    const lines = res.text.split("\r\n");
    expect(lines[0]).toBe("id,name,domain,website,country,region,city,industry,status,do_not_contact,created_at");
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`); // apostrophe-prefixed and quoted
    expect(res.text).toContain(`"Acme, ""Norte"" S.A."`);
    expect(res.text).toContain(",'@cmd Company,");
    expect(lines.filter((l) => l.length > 0)).toHaveLength(4);

    const mx = await raw("/prospects/export?country=MX", a.token);
    expect(mx.text.split("\r\n").filter((l) => l.length > 0)).toHaveLength(2);
    expect((await raw("/prospects/export?status=bogus", a.token)).status).toBe(400);
    expect((await raw("/prospects/export?limit=5", a.token)).status).toBe(400); // no hidden knobs

    const audit = await owner.query("SELECT metadata FROM audit_events WHERE organization_id = $1 AND action = 'export.created' ORDER BY created_at", [a.orgId]);
    expect(audit.rows[0].metadata).toMatchObject({ rows: 3, truncated: false });
    expect(audit.rowCount).toBe(2);
  });

  it("is limited to the caller's organization and requires authentication and prospects:read", async () => {
    const a = await register("exp-iso-a");
    const b = await register("exp-iso-b");
    await api.call("POST", "/prospects", { token: a.token, body: { name: "Only A Corp" } });
    expect((await raw("/prospects/export", b.token)).text).not.toContain("Only A Corp");
    expect((await raw("/prospects/export")).status).toBe(401);
    const viewer = await member(a.orgId, "viewer");
    expect((await raw("/prospects/export", viewer)).text).toContain("Only A Corp");
  });
});

describe("analytics export", () => {
  it("exports the records behind a metric for roles with analytics:read only", async () => {
    const a = await register("exp-analytics");
    const p = (await api.call("POST", "/prospects", { token: a.token, body: { name: "=2+2 Industrial", domain: `an-${randomUUID().slice(0, 6)}.example` } })).body;
    const res = await raw("/analytics/events/export?metric=prospects_created", a.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="analytics-prospects_created.csv"');
    expect(res.text.split("\r\n")[0]).toBe("id,at,type,title");
    expect(res.text).toContain(p.id);
    expect(res.text).toContain("'=2+2 Industrial");

    expect((await raw("/analytics/events/export?metric=bogus", a.token)).status).toBe(400);
    expect((await raw("/analytics/events/export?metric=prospects_created&from=2026-12-31&to=2026-01-01", a.token)).status).toBe(400);
    expect((await raw("/analytics/events/export?metric=prospects_created&limit=1", a.token)).status).toBe(400);
    expect((await raw("/analytics/events/export?metric=prospects_created")).status).toBe(401);
    expect((await raw("/analytics/events/export?metric=prospects_created", await member(a.orgId, "seller"))).status).toBe(403);
    expect((await raw("/analytics/events/export?metric=prospects_created", await member(a.orgId, "analyst"))).status).toBe(200);

    const other = await register("exp-analytics-other");
    expect((await raw("/analytics/events/export?metric=prospects_created", other.token)).text).not.toContain(p.id);
    const audit = await owner.query("SELECT metadata FROM audit_events WHERE organization_id = $1 AND action = 'export.created' AND resource_type = 'analytics'", [a.orgId]);
    expect(audit.rows[0].metadata).toMatchObject({ metric: "prospects_created", rows: 1, truncated: false });
  });
});

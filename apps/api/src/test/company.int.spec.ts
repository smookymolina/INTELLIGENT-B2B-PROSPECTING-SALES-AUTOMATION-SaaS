import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMBERSHIP_ROLES, type MembershipRole } from "@prospecting/contracts";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** P3-01: company profile and branches - validation, RBAC, tenant isolation (API + RLS), audit. */
let api: Api;
type Account = { token: string; orgId: string; userId: string };

async function register(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label}` } });
  const me = await api.call("GET", "/me", { token: res.body.token });
  return { token: res.body.token, orgId: res.body.organization.id, userId: me.body.user.id };
}
async function asRole(orgId: string, role: MembershipRole): Promise<string> {
  const m = await seedMember(orgId, role);
  return (await api.call("POST", "/auth/login", { body: { email: m.email, password: PASSWORD } })).body.token;
}
const profile = { legalName: "Acme Example S.A.", industry: "Logistics", website: "https://example.test", country: "MX", timezone: "America/Mexico_City", defaultCurrency: "MXN" };

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("company profile", () => {
  it("starts empty (nothing is inferred) and is replaced wholesale by PUT", async () => {
    const a = await register("prof-a");
    const empty = await api.call("GET", "/organization/profile", { token: a.token });
    expect(empty.body).toEqual({ legalName: null, tradeName: null, industry: null, website: null, description: null, country: null, timezone: null, defaultCurrency: null, updatedAt: null });

    const put = await api.call("PUT", "/organization/profile", { token: a.token, body: { ...profile, tradeName: "Acme" } });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ ...profile, tradeName: "Acme" });
    expect((await api.call("GET", "/organization/profile", { token: a.token })).body).toMatchObject({ legalName: profile.legalName });

    const replaced = await api.call("PUT", "/organization/profile", { token: a.token, body: { legalName: "Only Name" } });
    expect(replaced.body).toMatchObject({ legalName: "Only Name", tradeName: null, country: null, defaultCurrency: null });
  });

  it("is idempotent: repeating the same PUT yields the same state", async () => {
    const a = await register("prof-idem");
    const first = await api.call("PUT", "/organization/profile", { token: a.token, body: profile });
    const second = await api.call("PUT", "/organization/profile", { token: a.token, body: profile });
    expect({ ...second.body, updatedAt: null }).toEqual({ ...first.body, updatedAt: null });
    expect((await owner.query("SELECT 1 FROM organization_profiles WHERE organization_id = $1", [a.orgId])).rowCount).toBe(1);
  });

  it.each([
    ["lowercase country", { country: "mx" }],
    ["3-letter country", { country: "MEX" }],
    ["bad currency", { defaultCurrency: "peso" }],
    ["javascript: website", { website: "javascript:alert(1)" }],
    ["ftp website", { website: "ftp://example.test/x" }],
    ["unknown time zone", { timezone: "Mars/Olympus" }],
    ["empty text", { legalName: "   " }],
    ["oversize text", { description: "x".repeat(2001) }],
    ["tenant id", { organization_id: randomUUID() }],
    ["tenant id camelCase", { organizationId: randomUUID() }],
  ])("rejects %s", async (_name, patch) => {
    const a = await register("prof-val");
    expect((await api.call("PUT", "/organization/profile", { token: a.token, body: { ...profile, ...patch } })).status).toBe(400);
    expect((await api.call("GET", "/organization/profile", { token: a.token })).body.updatedAt).toBeNull();
  });

  it("audits which fields changed but never their values", async () => {
    const a = await register("prof-audit");
    await api.call("PUT", "/organization/profile", { token: a.token, body: { legalName: "Secret Legal Name", country: "US" } });
    await api.call("PUT", "/organization/profile", { token: a.token, body: { legalName: "Secret Legal Name", country: "CA" } });
    const events = (await api.call("GET", "/audit-events?limit=100", { token: a.token })).body as Array<{ action: string; metadata: { changedFields: string[] } }>;
    const updates = events.filter((e) => e.action === "organization.profile_updated");
    expect(updates.map((e) => e.metadata.changedFields.sort())).toEqual([["country"], ["country", "legal_name"]]);
    expect(JSON.stringify(events)).not.toContain("Secret Legal Name");
  });
});

describe("branches", () => {
  it("creates, lists, edits and disables (never deletes) branches", async () => {
    const a = await register("br-a");
    const created = await api.call("POST", "/branches", { token: a.token, body: { name: "HQ", city: "Monterrey", country: "MX" } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "HQ", city: "Monterrey", country: "MX", status: "active", address: null });
    const edited = await api.call("PATCH", `/branches/${created.body.id}`, { token: a.token, body: { region: "NL", city: null } });
    expect(edited.body).toMatchObject({ region: "NL", city: null });
    const disabled = await api.call("PATCH", `/branches/${created.body.id}`, { token: a.token, body: { status: "disabled" } });
    expect(disabled.body.status).toBe("disabled");
    expect((await api.call("GET", "/branches", { token: a.token })).body).toHaveLength(1);
    expect((await api.call("DELETE", `/branches/${created.body.id}`, { token: a.token })).status).toBe(404);
    const actions = (await api.call("GET", "/audit-events?limit=100", { token: a.token })).body.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["branch.created", "branch.updated", "branch.disabled"]));
  });

  it("enforces case-insensitive unique names per organization only", async () => {
    const a = await register("br-uniq-a");
    const b = await register("br-uniq-b");
    expect((await api.call("POST", "/branches", { token: a.token, body: { name: "Norte" } })).status).toBe(201);
    const dup = await api.call("POST", "/branches", { token: a.token, body: { name: "NORTE" } });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("CONFLICT");
    expect((await api.call("POST", "/branches", { token: b.token, body: { name: "Norte" } })).status).toBe(201);
    const other = await api.call("POST", "/branches", { token: a.token, body: { name: "Sur" } });
    expect((await api.call("PATCH", `/branches/${other.body.id}`, { token: a.token, body: { name: "norte" } })).status).toBe(409);
  });

  it("validates input", async () => {
    const a = await register("br-val");
    const created = await api.call("POST", "/branches", { token: a.token, body: { name: "Valid" } });
    for (const body of [{}, { name: "" }, { name: "x", country: "mx" }, { name: "x", organization_id: randomUUID() }, { name: "x", status: "disabled" }]) {
      expect((await api.call("POST", "/branches", { token: a.token, body })).status).toBe(400);
    }
    for (const body of [{}, { status: "deleted" }, { organization_id: randomUUID() }]) {
      expect((await api.call("PATCH", `/branches/${created.body.id}`, { token: a.token, body })).status).toBe(400);
    }
    expect((await api.call("PATCH", "/branches/not-a-uuid", { token: a.token, body: { name: "x" } })).status).toBe(400);
  });
});

describe("RBAC", () => {
  it.each(MEMBERSHIP_ROLES)("%s: everyone reads, only org_admin writes", async (role) => {
    const a = await register(`rbac-${role}`);
    const branch = await api.call("POST", "/branches", { token: a.token, body: { name: "Existing" } });
    const token = role === "org_admin" ? a.token : await asRole(a.orgId, role);
    const writable = role === "org_admin" ? 200 : 403;
    expect((await api.call("GET", "/organization/profile", { token })).status).toBe(200);
    expect((await api.call("GET", "/branches", { token })).status).toBe(200);
    expect((await api.call("PUT", "/organization/profile", { token, body: profile })).status).toBe(writable);
    expect((await api.call("POST", "/branches", { token, body: { name: `By ${role}` } })).status).toBe(role === "org_admin" ? 201 : 403);
    expect((await api.call("PATCH", `/branches/${branch.body.id}`, { token, body: { city: "X" } })).status).toBe(writable);
  });
});

describe("tenant isolation", () => {
  it("tenant A cannot read or change tenant B's profile or branches through the API", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    await api.call("PUT", "/organization/profile", { token: b.token, body: { legalName: "B Legal" } });
    const bBranch = await api.call("POST", "/branches", { token: b.token, body: { name: "B Branch" } });

    expect((await api.call("GET", "/organization/profile", { token: a.token })).body.legalName).toBeNull();
    expect((await api.call("GET", "/branches", { token: a.token })).body).toEqual([]);
    expect((await api.call("PATCH", `/branches/${bBranch.body.id}`, { token: a.token, body: { name: "pwned" } })).status).toBe(404);
    expect((await owner.query("SELECT name FROM branches WHERE id = $1", [bBranch.body.id])).rows[0].name).toBe("B Branch");
    expect((await api.call("GET", "/organization/profile", { token: b.token })).body.legalName).toBe("B Legal");
  });

  it("RLS blocks cross-tenant and non-admin writes at the database level", async () => {
    const a = await register("rls-a");
    const b = await register("rls-b");
    const bBranch = await api.call("POST", "/branches", { token: b.token, body: { name: "B" } });
    await api.call("PUT", "/organization/profile", { token: b.token, body: { legalName: "B Legal" } });
    const ctx = { organizationId: a.orgId, userId: a.userId, role: "org_admin" };
    const denied = (sql: string, params: unknown[], c = ctx) => asRuntime(c, async (cl) => cl.query(sql, params).then(() => "NO ERROR", (e: Error) => e.message));

    await asRuntime(ctx, async (c) => {
      expect((await c.query("SELECT 1 FROM branches WHERE organization_id = $1", [b.orgId])).rowCount).toBe(0);
      expect((await c.query("SELECT 1 FROM organization_profiles WHERE organization_id = $1", [b.orgId])).rowCount).toBe(0);
      expect((await c.query("UPDATE branches SET name = 'x' WHERE id = $1", [bBranch.body.id])).rowCount).toBe(0);
      expect((await c.query("UPDATE organization_profiles SET legal_name = 'x' WHERE organization_id = $1", [b.orgId])).rowCount).toBe(0);
    });
    expect(await denied("INSERT INTO branches (organization_id, name, name_key) VALUES ($1,'x','x')", [b.orgId])).toMatch(/row-level security/);
    expect(await denied("INSERT INTO organization_profiles (organization_id, legal_name) VALUES ($1,'x')", [b.orgId])).toMatch(/row-level security/);
    expect(await denied("INSERT INTO branches (organization_id, name, name_key) VALUES ($1,'x','x')", [a.orgId], { ...ctx, role: "viewer" })).toMatch(/row-level security/);
    expect(await denied("UPDATE branches SET organization_id = $1 WHERE id = $2", [b.orgId, bBranch.body.id])).toMatch(/permission denied/);
    expect(await denied("DELETE FROM branches", [])).toMatch(/permission denied/);
    expect(await denied("INSERT INTO organization_profiles (organization_id, country, updated_at) VALUES ($1,'mx', now())", [a.orgId])).toMatch(/violates check constraint/);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** Superadministrador de plataforma: lectura global solo mediante funciones DEFINER, auditada en el tenant consultado; nunca escritura. */
let api: Api;
type Account = { token: string; orgId: string; userId: string };
async function register(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label}` } });
  const me = await api.call("GET", "/me", { token: res.body.token });
  return { token: res.body.token, orgId: res.body.organization.id, userId: me.body.user.id };
}
const audits = async (orgId: string) => (await owner.query("SELECT actor_user_id, resource_id, metadata FROM audit_events WHERE organization_id = $1 AND action = 'platform_admin.read'", [orgId])).rows;
const RESOURCES = ["users", "prospects", "leads", "opportunities", "quotes", "campaigns"];

let pa: Account, orgA: Account, orgB: Account;
beforeAll(async () => {
  api = await startApi();
  pa = await register("platform");
  orgA = await register("tenantA");
  orgB = await register("tenantB");
  await owner.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [pa.userId]); // asignacion solo por SQL de operador
  const p = await api.call("POST", "/prospects", { token: orgB.token, body: { name: "Cliente Secreto SL", domain: `sec-${randomUUID().slice(0, 6)}.example` } });
  expect(p.status).toBe(201);
});
afterAll(async () => {
  await api.close();
});

describe("platform admin", () => {
  it("usuario normal y org_admin no acceden (403); sin sesion 401", async () => {
    expect((await api.call("GET", "/platform-admin/organizations", { token: orgA.token })).status).toBe(403);
    const v = await seedMember(orgA.orgId, "viewer");
    const t = (await api.call("POST", "/auth/login", { body: { email: v.email, password: PASSWORD } })).body.token;
    expect((await api.call("GET", `/platform-admin/organizations/${orgB.orgId}/users`, { token: t })).status).toBe(403);
    expect((await api.call("GET", "/platform-admin/organizations")).status).toBe(401);
    expect(await audits(orgB.orgId)).toHaveLength(0);
  });

  it("platform_admin lee organizaciones ajenas y cada lectura queda auditada con actor y organizacion", async () => {
    // The shared test database holds hundreds of organizations: page until orgB shows up.
    let list = await api.call("GET", "/platform-admin/organizations?limit=100", { token: pa.token });
    expect(list.status).toBe(200);
    let b = list.body.items.find((o: { id: string }) => o.id === orgB.orgId);
    for (let off = 100; !b && off < list.body.total; off += 100) {
      list = await api.call("GET", `/platform-admin/organizations?limit=100&offset=${off}`, { token: pa.token });
      b = list.body.items.find((o: { id: string }) => o.id === orgB.orgId);
    }
    expect(b.counts.prospects).toBe(1);
    const pros = await api.call("GET", `/platform-admin/organizations/${orgB.orgId}/prospects`, { token: pa.token });
    expect(pros.status).toBe(200);
    expect(pros.body.items[0].name).toBe("Cliente Secreto SL");
    for (const r of RESOURCES.filter((x) => x !== "prospects")) expect((await api.call("GET", `/platform-admin/organizations/${orgB.orgId}/${r}`, { token: pa.token })).status).toBe(200);
    const rows = await audits(orgB.orgId);
    expect(rows.length).toBeGreaterThanOrEqual(7);
    expect(rows.every((r) => r.actor_user_id === pa.userId && r.resource_id === orgB.orgId)).toBe(true);
    expect(new Set(rows.map((r) => r.metadata.resource))).toEqual(new Set(["organizations", ...RESOURCES]));
  });

  it("paginacion acotada, recurso desconocido y organizacion inexistente", async () => {
    expect((await api.call("GET", "/platform-admin/organizations?limit=101", { token: pa.token })).status).toBe(400);
    expect((await api.call("GET", `/platform-admin/organizations/${orgB.orgId}/secrets`, { token: pa.token })).status).toBe(400);
    expect((await api.call("GET", `/platform-admin/organizations/${randomUUID()}/users`, { token: pa.token })).status).toBe(404);
    const one = await api.call("GET", `/platform-admin/organizations/${orgB.orgId}/users?limit=1&offset=0`, { token: pa.token });
    expect(one.body.items.length).toBe(1);
  });

  it("no expone secretos (hashes, tokens, SMTP)", async () => {
    let all = JSON.stringify((await api.call("GET", "/platform-admin/organizations?limit=100", { token: pa.token })).body);
    for (const r of RESOURCES) all += JSON.stringify((await api.call("GET", `/platform-admin/organizations/${orgB.orgId}/${r}`, { token: pa.token })).body);
    expect(all).not.toMatch(/password|hash|cipher|argon|token|smtp/i);
  });

  it("ni el platform_admin puede escribir; ningun endpoint asigna el rol", async () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of ["/platform-admin/organizations", `/platform-admin/organizations/${orgB.orgId}/users`, "/platform-admin/admins"]) {
        const r = await api.call(m, path, { token: pa.token, body: { userId: orgA.userId } });
        expect([404, 405]).toContain(r.status);
      }
    }
    expect((await owner.query("SELECT 1 FROM platform_admins WHERE user_id = $1", [orgA.userId])).rowCount).toBe(0);
    const ctx = { organizationId: pa.orgId, userId: pa.userId, role: "org_admin" };
    await asRuntime(ctx, async (c) => {
      await expect(c.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [orgA.userId])).rejects.toThrow(/permission denied/);
    });
    await asRuntime(ctx, async (c) => {
      await expect(c.query("SELECT * FROM platform_admins")).rejects.toThrow(/permission denied/);
    });
  });

  it("los tenants siguen aislados: sin bypass general de RLS y las funciones rechazan a los demas", async () => {
    await asRuntime({ organizationId: pa.orgId, userId: pa.userId, role: "org_admin" }, async (c) => {
      expect((await c.query("SELECT 1 FROM prospects WHERE organization_id = $1", [orgB.orgId])).rowCount).toBe(0);
      expect((await c.query("SELECT 1 FROM audit_events WHERE organization_id = $1", [orgB.orgId])).rowCount).toBe(0);
    });
    await asRuntime({ organizationId: orgA.orgId, userId: orgA.userId, role: "org_admin" }, async (c) => {
      expect((await c.query("SELECT 1 FROM prospects WHERE organization_id = $1", [orgB.orgId])).rowCount).toBe(0);
      await expect(c.query("SELECT platform_admin_resource($1, 'users', 5, 0, 'x')", [orgB.orgId])).rejects.toThrow(/platform_admin_required/);
    });
    await asRuntime({ organizationId: orgA.orgId, userId: orgA.userId, role: "org_admin" }, async (c) => {
      await expect(c.query("SELECT * FROM platform_admin_organizations(5, 0, 'x')")).rejects.toThrow(/platform_admin_required/);
    });
  });
});

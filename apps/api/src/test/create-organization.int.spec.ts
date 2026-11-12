import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Api, owner, PASSWORD, startApi } from "./harness.js";

/** POST /auth/organizations: an authenticated user creates another organization and lands in it as org_admin. */
let api: Api;

async function register(label: string) {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label} ${randomUUID().slice(0, 6)}` } });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, orgId: res.body.organization.id as string, slug: res.body.organization.slug as string };
}
const create = (token: string | undefined, organizationName: string) => api.call("POST", "/auth/organizations", { ...(token ? { token } : {}), body: { organizationName } });

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("create organization", () => {
  it("creates the organization, opens an org_admin session in it and keeps the old one reachable via switch", async () => {
    const home = await register("co-home");
    const res = await create(home.token, "Second Business");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ role: "org_admin", organization: { name: "Second Business" } });
    const newOrgId = res.body.organization.id as string;
    expect(newOrgId).not.toBe(home.orgId);

    expect((await api.call("GET", "/me", { token: res.body.token })).body).toMatchObject({ organization: { id: newOrgId }, role: "org_admin" });
    expect((await api.call("GET", "/me", { token: home.token })).status).toBe(401); // previous session revoked, like switch

    const orgs = (await api.call("GET", "/me/organizations", { token: res.body.token })).body.items as Array<{ id: string; role: string; current: boolean }>;
    expect(orgs.map((o) => o.id).sort()).toEqual([home.orgId, newOrgId].sort());
    expect(orgs.find((o) => o.id === newOrgId)).toMatchObject({ role: "org_admin", current: true });

    const back = await api.call("POST", "/auth/switch-organization", { token: res.body.token, body: { organizationSlug: home.slug } });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ role: "org_admin", organization: { id: home.orgId } });

    const audit = await owner.query("SELECT action FROM audit_events WHERE organization_id = $1 AND action IN ('organization.created','membership.created')", [newOrgId]);
    expect(audit.rows.map((r) => r.action).sort()).toEqual(["membership.created", "organization.created"]);
  });

  it("isolates data between the two businesses", async () => {
    const home = await register("co-iso");
    const domain = `iso-${randomUUID().slice(0, 8)}.example`;
    expect((await api.call("POST", "/prospects", { token: home.token, body: { name: "Only Home", domain } })).status).toBe(201);
    const res = await create(home.token, "Isolated Business");
    expect(res.status).toBe(201);
    const list = await api.call("GET", "/prospects", { token: res.body.token });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(domain);
    const back = await api.call("POST", "/auth/switch-organization", { token: res.body.token, body: { organizationSlug: home.slug } });
    expect(JSON.stringify((await api.call("GET", "/prospects", { token: back.body.token })).body)).toContain(domain);
  });

  it("requires authentication and a valid body", async () => {
    expect((await create(undefined, "No Auth Business")).status).toBe(401);
    const a = await register("co-val");
    expect((await create(a.token, "x")).status).toBe(400);
    expect((await api.call("POST", "/auth/organizations", { token: a.token, body: { organizationName: "Valid Name", organization_id: a.orgId } })).status).toBe(400);
  });

  it("answers 409 for a duplicate name", async () => {
    const a = await register("co-dup");
    const name = `Dup ${randomUUID().slice(0, 6)}`;
    const first = await create(a.token, name);
    expect(first.status).toBe(201);
    const second = await create(first.body.token, name);
    expect(second.status).toBe(409);
    expect((await api.call("GET", "/me", { token: first.body.token })).status).toBe(200); // failed creation keeps the session
  });

  it("limits administered organizations to 20", async () => {
    const a = await register("co-limit");
    let token = a.token;
    for (let i = 0; i < 19; i++) {
      const r = await create(token, `Limit ${i} ${randomUUID().slice(0, 6)}`);
      expect(r.status).toBe(201);
      token = r.body.token as string;
    }
    const over = await create(token, "One Too Many");
    expect(over.status).toBe(409);
    expect(JSON.stringify(over.body)).toContain("limit");
  });
});

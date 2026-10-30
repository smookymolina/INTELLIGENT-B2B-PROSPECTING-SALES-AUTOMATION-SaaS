import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Api, owner, PASSWORD, sameShape, seedMember, seedOrganization, startApi } from "./harness.js";

/** P2-14 (part): switching the active organization re-derives the tenant from the user's own memberships. */
let api: Api;

async function register(label: string) {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label}` } });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, orgId: res.body.organization.id as string, slug: res.body.organization.slug as string, email };
}
const switchTo = (token: string, organizationSlug: string) => api.call("POST", "/auth/switch-organization", { token, body: { organizationSlug } });

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("switch organization", () => {
  it("opens a session in the target organization with that membership's role and revokes the previous one", async () => {
    const home = await register("sw-home");
    const target = await register("sw-target");
    const guest = await seedMember(target.orgId, "analyst");
    // The guest also belongs to a second organization (their "home").
    const second = await seedOrganization("sw-second");
    await owner.query("INSERT INTO memberships (id, organization_id, user_id, role, updated_at) VALUES ($1,$2,$3,'seller', now())", [randomUUID(), second.id, guest.userId]);
    const login = await api.call("POST", "/auth/login", { body: { email: guest.email, password: PASSWORD, organizationSlug: second.slug } });
    expect(login.body).toMatchObject({ role: "seller", organization: { id: second.id } });

    const res = await switchTo(login.body.token, target.slug);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: "analyst", organization: { id: target.orgId, slug: target.slug } });
    expect((await api.call("GET", "/me", { token: res.body.token })).body).toMatchObject({ organization: { id: target.orgId }, role: "analyst" });
    expect((await api.call("GET", "/me", { token: login.body.token })).status).toBe(401); // previous session revoked
    expect((await api.call("GET", "/memberships", { token: res.body.token })).status).toBe(403); // analyst: RBAC of the new org applies
    void home;
  });

  it("refuses organizations the user does not belong to, identically to nonexistent ones", async () => {
    const a = await register("sw-a");
    const b = await register("sw-b");
    const foreign = await switchTo(a.token, b.slug);
    const ghost = await switchTo(a.token, `ghost-${randomUUID().slice(0, 8)}`);
    expect(foreign.status).toBe(404);
    expect(sameShape(foreign)).toEqual(sameShape(ghost));
    expect((await api.call("GET", "/me", { token: a.token })).status).toBe(200); // failed switch keeps the session
  });

  it("rejects tenant ids in the body, requires authentication, and respects removed memberships", async () => {
    const a = await register("sw-strict");
    const b = await register("sw-strict-b");
    expect((await api.call("POST", "/auth/switch-organization", { token: a.token, body: { organizationSlug: b.slug, organization_id: b.orgId } })).status).toBe(400);
    expect((await api.call("POST", "/auth/switch-organization", { body: { organizationSlug: a.slug } })).status).toBe(401);

    const guest = await seedMember(b.orgId, "viewer");
    const home = await seedOrganization("sw-removed-home");
    await owner.query("INSERT INTO memberships (id, organization_id, user_id, role, updated_at) VALUES ($1,$2,$3,'viewer', now())", [randomUUID(), home.id, guest.userId]);
    const login = await api.call("POST", "/auth/login", { body: { email: guest.email, password: PASSWORD, organizationSlug: home.slug } });
    await owner.query("DELETE FROM memberships WHERE id = $1", [guest.membershipId]);
    expect((await switchTo(login.body.token, b.slug)).status).toBe(404);
  });

  it("is audited in the target organization with the server request id", async () => {
    const target = await register("sw-audit");
    const guest = await seedMember(target.orgId, "viewer");
    const home = await seedOrganization("sw-audit-home");
    await owner.query("INSERT INTO memberships (id, organization_id, user_id, role, updated_at) VALUES ($1,$2,$3,'viewer', now())", [randomUUID(), home.id, guest.userId]);
    const login = await api.call("POST", "/auth/login", { body: { email: guest.email, password: PASSWORD, organizationSlug: home.slug } });
    const res = await switchTo(login.body.token, target.slug);
    const { rows } = await owner.query("SELECT request_id, actor_user_id, metadata FROM audit_events WHERE organization_id = $1 AND action = 'auth.organization_switched'", [target.orgId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].request_id).toBe(res.headers.get("x-request-id"));
    expect(rows[0].metadata).toEqual({ fromOrganizationId: home.id });
    expect((await owner.query("SELECT 1 FROM audit_events WHERE organization_id = $1 AND action = 'auth.logout'", [home.id])).rowCount).toBe(1);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMBERSHIP_ROLES, type MembershipRole } from "@prospecting/contracts";
import { type Api, owner, sameShape, PASSWORD, seedMember, startApi } from "./harness.js";

/** End-to-end proofs through HTTP: identity -> tenant context -> RBAC -> RLS -> audit. */
let api: Api;

type Tenant = { token: string; orgId: string; slug: string; email: string; userId: string; membershipId: string };

async function register(label: string): Promise<Tenant> {
  const id = randomUUID().slice(0, 8);
  const email = `${label}-${id}@example.test`;
  const res = await api.call("POST", "/auth/register", {
    body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label} ${id}` },
  });
  expect(res.status).toBe(201);
  const me = await api.call("GET", "/me", { token: res.body.token });
  const members = await api.call("GET", "/memberships", { token: res.body.token });
  return {
    token: res.body.token,
    orgId: res.body.organization.id,
    slug: res.body.organization.slug,
    email,
    userId: me.body.user.id,
    membershipId: members.body[0].id,
  };
}

async function loginAs(email: string, organizationSlug?: string) {
  return api.call("POST", "/auth/login", { body: { email, password: PASSWORD, ...(organizationSlug ? { organizationSlug } : {}) } });
}

async function member(orgId: string, role: MembershipRole) {
  const seeded = await seedMember(orgId, role);
  const login = await loginAs(seeded.email);
  expect(login.status).toBe(200);
  return { ...seeded, token: login.body.token as string };
}

const actions = async (t: Tenant) => (await api.call("GET", "/audit-events?limit=100", { token: t.token })).body.map((e: { action: string }) => e.action);

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("authentication", () => {
  it("rejects missing, malformed and unknown tokens", async () => {
    expect((await api.call("GET", "/me")).status).toBe(401);
    expect((await api.call("GET", "/me", { token: "short" })).status).toBe(401);
    expect((await api.call("GET", "/me", { token: "x".repeat(43) })).status).toBe(401);
  });

  it("keeps health public and everything else private by default", async () => {
    expect((await api.call("GET", "/health")).status).toBe(200);
    for (const path of ["/organization", "/memberships", "/audit-events"]) expect((await api.call("GET", path)).status).toBe(401);
  });

  it("does not reveal whether an email exists and rejects bad passwords", async () => {
    const t = await register("auth-a");
    const wrong = await api.call("POST", "/auth/login", { body: { email: t.email, password: "wrong wrong wrong" } });
    const unknown = await api.call("POST", "/auth/login", { body: { email: "nobody@example.test", password: "wrong wrong wrong" } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(sameShape(wrong)).toEqual(sameShape(unknown));
  });

  it("stores only a hash of the session token", async () => {
    const t = await register("auth-hash");
    const { rows } = await owner.query("SELECT token_hash FROM sessions WHERE organization_id = $1", [t.orgId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(t.token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    const user = await owner.query("SELECT password_hash FROM users WHERE id = $1", [t.userId]);
    expect(user.rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(user.rows[0].password_hash).not.toContain(PASSWORD);
  });

  it("logout revokes the token immediately", async () => {
    const t = await register("auth-logout");
    expect((await api.call("POST", "/auth/logout", { token: t.token })).status).toBe(204);
    expect((await api.call("GET", "/me", { token: t.token })).status).toBe(401);
  });

  it("rejects duplicate registration without leaking details", async () => {
    const t = await register("auth-dup");
    const dup = await api.call("POST", "/auth/register", { body: { email: t.email, password: PASSWORD, displayName: "x", organizationName: "Dup Org" } });
    expect(dup.status).toBe(409);
    expect(JSON.stringify(dup.body)).not.toContain(t.email);
    expect(dup.body.code).toBe("CONFLICT");
  });
});

describe("input validation", () => {
  it("rejects client-supplied tenant identifiers in every writable body", async () => {
    const a = await register("val-a");
    const b = await register("val-b");
    for (const key of ["organization_id", "organizationId"]) {
      const reg = await api.call("POST", "/auth/register", {
        body: { email: `val-${randomUUID()}@example.test`, password: PASSWORD, displayName: "x", organizationName: "Legit Org", [key]: b.orgId },
      });
      expect(reg.status).toBe(400);
      const rename = await api.call("PATCH", "/organization", { token: a.token, body: { name: "Renamed", [key]: b.orgId } });
      expect(rename.status).toBe(400);
      const role = await api.call("PATCH", `/memberships/${a.membershipId}`, { token: a.token, body: { role: "viewer", [key]: b.orgId } });
      expect(role.status).toBe(400);
    }
    expect((await api.call("GET", "/organization", { token: b.token })).body.name).toMatch(/^Org val-b/);
  });

  it("rejects weak passwords, invalid emails, bad ids and oversize limits without echoing input", async () => {
    const weak = await api.call("POST", "/auth/register", { body: { email: "weak@example.test", password: "short", displayName: "x", organizationName: "Weak Org" } });
    expect(weak.status).toBe(400);
    expect(JSON.stringify(weak.body)).not.toContain("short");
    expect((await api.call("POST", "/auth/register", { body: { email: "not-an-email", password: PASSWORD, displayName: "x", organizationName: "Org" } })).status).toBe(400);
    const a = await register("val-ids");
    expect((await api.call("PATCH", "/memberships/not-a-uuid", { token: a.token, body: { role: "viewer" } })).status).toBe(400);
    expect((await api.call("GET", "/audit-events?limit=100000", { token: a.token })).status).toBe(400);
  });
});

describe("tenant context comes only from the session", () => {
  it("ignores tenant hints in headers and query strings", async () => {
    const a = await register("ctx-a");
    const b = await register("ctx-b");
    const res = await api.call("GET", `/organization?organization_id=${b.orgId}`, {
      token: a.token,
      headers: { "x-organization-id": b.orgId, "x-tenant-id": b.orgId },
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(a.orgId);
  });

  it("login org selection is verified against the user's own memberships", async () => {
    const a = await register("sel-a");
    const b = await register("sel-b");
    const own = await loginAs(a.email, a.slug);
    expect(own.status).toBe(200);
    expect(own.body.organization.id).toBe(a.orgId);
    const foreign = await loginAs(a.email, b.slug);
    expect(foreign.status).toBe(403);
  });

  it("a multi-organization user is scoped to the organization of the chosen session", async () => {
    const a = await register("multi-a");
    const b = await register("multi-b");
    const extra = await seedMember(b.orgId, "viewer");
    await owner.query("INSERT INTO memberships (id, organization_id, user_id, role, updated_at) VALUES ($1,$2,$3,'analyst', now())", [randomUUID(), a.orgId, extra.userId]);
    const inA = await loginAs(extra.email, a.slug);
    const inB = await loginAs(extra.email, b.slug);
    expect((await api.call("GET", "/me", { token: inA.body.token })).body).toMatchObject({ organization: { id: a.orgId }, role: "analyst" });
    expect((await api.call("GET", "/me", { token: inB.body.token })).body).toMatchObject({ organization: { id: b.orgId }, role: "viewer" });
  });
});

describe("cross-tenant isolation through the API", () => {
  it("tenant A cannot read, change or delete tenant B's data", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    const bViewer = await member(b.orgId, "viewer");

    const listed = await api.call("GET", "/memberships", { token: a.token });
    expect(listed.body.map((m: { id: string }) => m.id)).toEqual([a.membershipId]);

    expect((await api.call("PATCH", `/memberships/${b.membershipId}`, { token: a.token, body: { role: "viewer" } })).status).toBe(404);
    expect((await api.call("PATCH", `/memberships/${bViewer.membershipId}`, { token: a.token, body: { role: "org_admin" } })).status).toBe(404);
    expect((await api.call("DELETE", `/memberships/${bViewer.membershipId}`, { token: a.token })).status).toBe(404);

    const { rows } = await owner.query("SELECT role FROM memberships WHERE id = ANY($1)", [[b.membershipId, bViewer.membershipId]]);
    expect(rows.map((r) => r.role).sort()).toEqual(["org_admin", "viewer"]);

    expect(await actions(a)).not.toContain("membership.role_changed");
    const aAudit = (await api.call("GET", "/audit-events?limit=100", { token: a.token })).body;
    expect(aAudit.every((e: { actorUserId: string }) => e.actorUserId === a.userId)).toBe(true);
  });

  it("a removed member loses access immediately", async () => {
    const a = await register("rem-a");
    const viewer = await member(a.orgId, "viewer");
    expect((await api.call("GET", "/organization", { token: viewer.token })).status).toBe(200);
    expect((await api.call("DELETE", `/memberships/${viewer.membershipId}`, { token: a.token })).status).toBe(204);
    expect((await api.call("GET", "/organization", { token: viewer.token })).status).toBe(401);
  });
});

describe("RBAC matrix", () => {
  const matrix: Record<MembershipRole, { organization: number; rename: number; members: number; manage: number; audit: number }> = {
    org_admin: { organization: 200, rename: 200, members: 200, manage: 200, audit: 200 },
    campaign_manager: { organization: 200, rename: 403, members: 200, manage: 403, audit: 403 },
    sales_manager: { organization: 200, rename: 403, members: 200, manage: 403, audit: 403 },
    seller: { organization: 200, rename: 403, members: 403, manage: 403, audit: 403 },
    analyst: { organization: 200, rename: 403, members: 403, manage: 403, audit: 403 },
    viewer: { organization: 200, rename: 403, members: 403, manage: 403, audit: 403 },
  };

  it("covers every role", () => {
    expect(Object.keys(matrix).sort()).toEqual([...MEMBERSHIP_ROLES].sort());
  });

  it.each(MEMBERSHIP_ROLES)("%s gets exactly its permissions", async (role) => {
    const a = await register(`rbac-${role}`);
    const actor = role === "org_admin" ? a : await member(a.orgId, role);
    const target = await seedMember(a.orgId, "seller");
    const expected = matrix[role];
    expect((await api.call("GET", "/organization", { token: actor.token })).status).toBe(expected.organization);
    expect((await api.call("PATCH", "/organization", { token: actor.token, body: { name: "Renamed Org" } })).status).toBe(expected.rename);
    expect((await api.call("GET", "/memberships", { token: actor.token })).status).toBe(expected.members);
    expect((await api.call("PATCH", `/memberships/${target.membershipId}`, { token: actor.token, body: { role: "analyst" } })).status).toBe(expected.manage);
    expect((await api.call("GET", "/audit-events", { token: actor.token })).status).toBe(expected.audit);
    const { rows } = await owner.query("SELECT role FROM memberships WHERE id = $1", [target.membershipId]);
    expect(rows[0].role).toBe(expected.manage === 200 ? "analyst" : "seller");
  });
});

describe("membership safety", () => {
  it("never leaves an organization without an active org_admin", async () => {
    const a = await register("last-admin");
    expect((await api.call("PATCH", `/memberships/${a.membershipId}`, { token: a.token, body: { role: "viewer" } })).status).toBe(409);
    expect((await api.call("DELETE", `/memberships/${a.membershipId}`, { token: a.token })).status).toBe(409);
  });

  it("holds under concurrent demotions of the two remaining admins", async () => {
    const a = await register("race");
    const second = await member(a.orgId, "org_admin");
    const results = await Promise.all([
      api.call("PATCH", `/memberships/${a.membershipId}`, { token: second.token, body: { role: "viewer" } }),
      api.call("PATCH", `/memberships/${second.membershipId}`, { token: a.token, body: { role: "viewer" } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const { rows } = await owner.query("SELECT count(*)::int AS n FROM memberships WHERE organization_id = $1 AND role = 'org_admin'", [a.orgId]);
    expect(rows[0].n).toBe(1);
  });
});

describe("audit trail", () => {
  it("records sensitive operations with actor, resource and a server-generated request id", async () => {
    const a = await register("audit");
    const seller = await member(a.orgId, "seller");
    await api.call("PATCH", "/organization", { token: a.token, body: { name: "Audited Org" } });
    await api.call("PATCH", `/memberships/${seller.membershipId}`, { token: a.token, body: { role: "analyst" } });
    await api.call("DELETE", `/memberships/${seller.membershipId}`, { token: a.token });

    const events = (await api.call("GET", "/audit-events?limit=100", { token: a.token })).body as Array<{
      action: string;
      actorUserId: string;
      resourceId: string | null;
      metadata: Record<string, unknown>;
    }>;
    const names = events.map((e) => e.action);
    expect(names).toEqual(expect.arrayContaining(["organization.created", "membership.created", "organization.updated", "membership.role_changed", "membership.removed"]));
    const changed = events.find((e) => e.action === "membership.role_changed");
    expect(changed).toMatchObject({ actorUserId: a.userId, resourceId: seller.membershipId, metadata: { from: "seller", to: "analyst" } });

    const { rows } = await owner.query("SELECT DISTINCT request_id FROM audit_events WHERE organization_id = $1 AND action = 'organization.updated'", [a.orgId]);
    expect(rows[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("logs login and logout in the session's tenant", async () => {
    const a = await register("audit-sess");
    const login = await loginAs(a.email);
    await api.call("POST", "/auth/logout", { token: login.body.token });
    const names = await actions(a);
    expect(names).toEqual(expect.arrayContaining(["auth.login", "auth.logout"]));
  });
});

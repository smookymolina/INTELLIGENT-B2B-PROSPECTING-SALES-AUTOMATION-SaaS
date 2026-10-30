import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMBERSHIP_ROLES, type MembershipRole } from "@prospecting/contracts";
import { type Api, asRuntime, owner, PASSWORD, sameShape, seedMember, startApi } from "./harness.js";

/** P2-11: invitations never create memberships; acceptance is single-use, email-bound, authenticated and uniform on failure. */
let api: Api;

type Account = { token: string; orgId: string; slug: string; email: string; userId: string };

async function register(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label}` } });
  expect(res.status).toBe(201);
  const me = await api.call("GET", "/me", { token: res.body.token });
  return { token: res.body.token, orgId: res.body.organization.id, slug: res.body.organization.slug, email, userId: me.body.user.id };
}

const invite = (admin: Account, email: string, role: MembershipRole = "analyst", key?: string) =>
  api.call("POST", "/invitations", { token: admin.token, body: { email, role }, ...(key ? { headers: { "idempotency-key": key } } : {}) });
const accept = (token: string, inviteToken: string) => api.call("POST", "/invitations/accept", { token, body: { token: inviteToken } });
const membership = async (orgId: string, userId: string) =>
  (await owner.query("SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2", [orgId, userId])).rows[0] as { role: string } | undefined;
const unknownToken = () => Buffer.from(randomUUID() + randomUUID()).toString("base64url").slice(0, 43);

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("creating an invitation", () => {
  it("creates a pending offer, returns the token once, and does NOT create a membership", async () => {
    const admin = await register("inv-admin");
    const invitee = await register("inv-invitee");
    const res = await invite(admin, invitee.email, "seller");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: invitee.email, role: "seller", invitedBy: admin.userId });
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await membership(admin.orgId, invitee.userId)).toBeUndefined();

    const list = await api.call("GET", "/invitations", { token: admin.token });
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(res.body.token);
  });

  it("stores only the SHA-256 of the token", async () => {
    const admin = await register("inv-hash");
    const res = await invite(admin, "someone@example.test");
    const { rows } = await owner.query("SELECT token_hash FROM invitations WHERE id = $1", [res.body.id]);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].token_hash).not.toBe(res.body.token);
  });

  it("responds identically for existing and non-existing accounts (no enumeration)", async () => {
    const admin = await register("inv-enum");
    const existing = await register("inv-enum-existing");
    const a = await invite(admin, existing.email);
    const b = await invite(admin, `nobody-${randomUUID().slice(0, 8)}@example.test`);
    expect(a.status).toBe(b.status);
    expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
  });

  it("a newer offer to the same email supersedes the older one", async () => {
    const admin = await register("inv-supersede");
    const invitee = await register("inv-supersede-to");
    const first = await invite(admin, invitee.email, "viewer");
    const second = await invite(admin, invitee.email, "seller");
    expect((await accept(invitee.token, first.body.token)).status).toBe(404);
    expect((await accept(invitee.token, second.body.token)).body.role).toBe("seller");
  });

  it("rejects client-supplied tenant ids and invalid input", async () => {
    const admin = await register("inv-strict");
    const other = await register("inv-strict-other");
    for (const key of ["organization_id", "organizationId"]) {
      expect((await api.call("POST", "/invitations", { token: admin.token, body: { email: "x@example.test", role: "viewer", [key]: other.orgId } })).status).toBe(400);
    }
    expect((await api.call("POST", "/invitations", { token: admin.token, body: { email: "not-an-email", role: "viewer" } })).status).toBe(400);
    expect((await api.call("POST", "/invitations", { token: admin.token, body: { email: "x@example.test", role: "saas_admin" } })).status).toBe(400);
    expect(await owner.query("SELECT 1 FROM invitations WHERE organization_id = $1", [other.orgId]).then((r) => r.rowCount)).toBe(0);
  });

  it("is idempotent with Idempotency-Key (one invitation, same token)", async () => {
    const admin = await register("inv-idem");
    const key = `inv-key-${randomUUID()}`;
    const a = await invite(admin, "idem@example.test", "viewer", key);
    const b = await invite(admin, "idem@example.test", "viewer", key);
    expect(b.body).toEqual(a.body);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect((await owner.query("SELECT 1 FROM invitations WHERE organization_id = $1", [admin.orgId])).rowCount).toBe(1);
    const other = await invite(admin, "different@example.test", "viewer", key);
    expect(other.status).toBe(422);
  });

  it("caps pending invitations per organization", async () => {
    const admin = await register("inv-cap");
    await owner.query(
      `INSERT INTO invitations (organization_id, email, role, token_hash, invited_by, expires_at)
       SELECT $1::uuid, 'cap-' || g || '@example.test', 'viewer', 'cap-' || g || '-' || $1::text, $2::uuid, now() + interval '1 day' FROM generate_series(1, 100) g`,
      [admin.orgId, admin.userId],
    );
    expect((await invite(admin, "one-too-many@example.test")).status).toBe(409);
  });
});

describe("accepting an invitation", () => {
  it("creates the membership only on acceptance, with the invited role, audited in the inviting organization", async () => {
    const admin = await register("acc-admin");
    const invitee = await register("acc-invitee");
    const created = await invite(admin, invitee.email, "campaign_manager");
    expect(await membership(admin.orgId, invitee.userId)).toBeUndefined();

    const res = await accept(invitee.token, created.body.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ organization: { id: admin.orgId, slug: admin.slug }, role: "campaign_manager", membershipCreated: true });
    expect(await membership(admin.orgId, invitee.userId)).toEqual({ role: "campaign_manager" });

    const events = (await api.call("GET", "/audit-events?limit=100", { token: admin.token })).body as Array<{ action: string; actorUserId: string }>;
    expect(events.filter((e) => ["invitation.created", "invitation.accepted", "membership.created"].includes(e.action)).map((e) => e.action)).toEqual(
      expect.arrayContaining(["invitation.created", "invitation.accepted", "membership.created"]),
    );
    expect(events.find((e) => e.action === "invitation.accepted")?.actorUserId).toBe(invitee.userId);

    const login = await api.call("POST", "/auth/login", { body: { email: invitee.email, password: PASSWORD, organizationSlug: admin.slug } });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ role: "campaign_manager", organization: { id: admin.orgId } });
  });

  it("is single use, including concurrent attempts", async () => {
    const admin = await register("acc-once");
    const invitee = await register("acc-once-to");
    const created = await invite(admin, invitee.email, "viewer");
    const results = await Promise.all([accept(invitee.token, created.body.token), accept(invitee.token, created.body.token)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    expect((await accept(invitee.token, created.body.token)).status).toBe(404);
  });

  it("refuses a different user's email without consuming the token", async () => {
    const admin = await register("acc-mismatch");
    const invitee = await register("acc-mismatch-to");
    const stranger = await register("acc-mismatch-stranger");
    const created = await invite(admin, invitee.email, "viewer");
    expect((await accept(stranger.token, created.body.token)).status).toBe(404);
    expect(await membership(admin.orgId, stranger.userId)).toBeUndefined();
    expect((await owner.query("SELECT accepted_at FROM invitations WHERE id = $1", [created.body.id])).rows[0].accepted_at).toBeNull();
    expect((await accept(invitee.token, created.body.token)).status).toBe(200);
  });

  it("requires authentication", async () => {
    const res = await api.call("POST", "/invitations/accept", { body: { token: unknownToken() } });
    expect(res.status).toBe(401);
  });

  it("any role can accept (no permission needed beyond being the invitee)", async () => {
    const admin = await register("acc-role");
    const viewer = await seedMember((await register("acc-role-home")).orgId, "viewer");
    const login = await api.call("POST", "/auth/login", { body: { email: viewer.email, password: PASSWORD } });
    const created = await invite(admin, viewer.email, "analyst");
    expect((await accept(login.body.token, created.body.token)).status).toBe(200);
  });

  it("never changes an existing membership (no silent privilege escalation)", async () => {
    const admin = await register("acc-existing");
    const existing = await seedMember(admin.orgId, "viewer");
    const login = await api.call("POST", "/auth/login", { body: { email: existing.email, password: PASSWORD } });
    const created = await invite(admin, existing.email, "org_admin");
    const res = await accept(login.body.token, created.body.token);
    expect(res.body).toMatchObject({ role: "viewer", membershipCreated: false });
    expect(await membership(admin.orgId, existing.userId)).toEqual({ role: "viewer" });
  });

  it("can grant org_admin when explicitly invited as org_admin", async () => {
    const admin = await register("acc-admin-role");
    const invitee = await register("acc-admin-role-to");
    const created = await invite(admin, invitee.email, "org_admin");
    expect((await accept(invitee.token, created.body.token)).body.role).toBe("org_admin");
  });
});

describe("uniform failure (no enumeration of invitations)", () => {
  it("unknown, expired, revoked, used and wrong-email tokens are indistinguishable", async () => {
    const admin = await register("uni-admin");
    const invitee = await register("uni-invitee");
    const stranger = await register("uni-stranger");

    const expired = await invite(admin, invitee.email);
    await owner.query("UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.body.id]);
    const revoked = await invite(admin, invitee.email);
    expect((await api.call("DELETE", `/invitations/${revoked.body.id}`, { token: admin.token })).status).toBe(204);
    const used = await invite(admin, invitee.email);
    expect((await accept(invitee.token, used.body.token)).status).toBe(200);
    const mismatch = await invite(admin, `other-${randomUUID().slice(0, 8)}@example.test`);

    const failures = [
      await accept(invitee.token, unknownToken()),
      await accept(invitee.token, expired.body.token),
      await accept(invitee.token, revoked.body.token),
      await accept(invitee.token, used.body.token),
      await accept(stranger.token, mismatch.body.token),
    ];
    for (const f of failures) expect(sameShape(f)).toEqual(sameShape(failures[0]!));
    expect(failures[0]!.status).toBe(404);
  });

  it("malformed tokens are a validation error that reveals nothing about stored invitations", async () => {
    const a = await register("uni-format");
    const res = await api.call("POST", "/invitations/accept", { token: a.token, body: { token: "short" } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("short");
  });
});

describe("permissions and tenant isolation", () => {
  it.each(MEMBERSHIP_ROLES.filter((r) => r !== "org_admin"))("%s cannot create, list or revoke invitations", async (role) => {
    const admin = await register(`perm-${role}`);
    const actor = await seedMember(admin.orgId, role);
    const login = await api.call("POST", "/auth/login", { body: { email: actor.email, password: PASSWORD } });
    const token = login.body.token as string;
    const pendingInvite = await invite(admin, "pending@example.test");
    expect((await api.call("POST", "/invitations", { token, body: { email: "x@example.test", role: "viewer" } })).status).toBe(403);
    expect((await api.call("GET", "/invitations", { token })).status).toBe(403);
    expect((await api.call("DELETE", `/invitations/${pendingInvite.body.id}`, { token })).status).toBe(403);
    expect((await owner.query("SELECT revoked_at FROM invitations WHERE id = $1", [pendingInvite.body.id])).rows[0].revoked_at).toBeNull();
  });

  it("tenant A cannot see or revoke tenant B's invitations", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    const bInvite = await invite(b, "b-guest@example.test");
    expect((await api.call("GET", "/invitations", { token: a.token })).body).toEqual([]);
    expect((await api.call("DELETE", `/invitations/${bInvite.body.id}`, { token: a.token })).status).toBe(404);
    expect((await owner.query("SELECT revoked_at FROM invitations WHERE id = $1", [bInvite.body.id])).rows[0].revoked_at).toBeNull();
  });

  it("RLS blocks cross-tenant and non-admin access at the database level; token_hash is unreadable", async () => {
    const a = await register("rls-a");
    const b = await register("rls-b");
    const bInvite = await invite(b, "b-rls@example.test");
    const ctx = { organizationId: a.orgId, userId: a.userId, role: "org_admin" };
    await asRuntime(ctx, async (c) => {
      expect((await c.query("SELECT id FROM invitations WHERE id = $1", [bInvite.body.id])).rowCount).toBe(0);
      expect((await c.query("UPDATE invitations SET revoked_at = now() WHERE id = $1", [bInvite.body.id])).rowCount).toBe(0);
    });
    const denied = async (sql: string, params: unknown[], c = ctx) => asRuntime(c, async (cl) => cl.query(sql, params).then(() => "NO ERROR", (e: Error) => e.message));
    expect(await denied("SELECT token_hash FROM invitations", [])).toMatch(/permission denied/);
    expect(await denied("INSERT INTO invitations (organization_id, email, role, token_hash, invited_by, expires_at) VALUES ($1,'x@example.test','viewer','h1',$2, now() + interval '1 day')", [b.orgId, a.userId])).toMatch(/row-level security/);
    expect(await denied("INSERT INTO invitations (organization_id, email, role, token_hash, invited_by, expires_at) VALUES ($1,'x@example.test','viewer','h2',$2, now() + interval '1 day')", [a.orgId, a.userId], { ...ctx, role: "viewer" })).toMatch(/row-level security/);
    expect(await denied("DELETE FROM invitations", [])).toMatch(/permission denied/);
    expect(await denied("UPDATE invitations SET email = 'y@example.test'", [])).toMatch(/permission denied/);
  });

  it("revoking works, is audited and makes the token unusable", async () => {
    const admin = await register("rev-admin");
    const invitee = await register("rev-invitee");
    const created = await invite(admin, invitee.email);
    expect((await api.call("DELETE", `/invitations/${created.body.id}`, { token: admin.token })).status).toBe(204);
    expect((await api.call("DELETE", `/invitations/${created.body.id}`, { token: admin.token })).status).toBe(404);
    expect((await api.call("GET", "/invitations", { token: admin.token })).body).toEqual([]);
    expect((await accept(invitee.token, created.body.token)).status).toBe(404);
    const events = (await api.call("GET", "/audit-events?limit=100", { token: admin.token })).body as Array<{ action: string }>;
    expect(events.map((e) => e.action)).toContain("invitation.revoked");
  });
});

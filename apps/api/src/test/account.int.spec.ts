import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Api, owner, PASSWORD, seedMember, seedOrganization, startApi } from "./harness.js";

/** P12-01: session listing/revocation and password change with global revocation of other sessions. */
let api: Api;

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

const NEW_PASSWORD = "a brand new passphrase 42";

async function member(role: "analyst" | "viewer" = "analyst") {
  const org = await seedOrganization(`acc-${randomUUID().slice(0, 6)}`);
  const m = await seedMember(org.id, role);
  const login = (slug = org.slug, password = PASSWORD) => api.call("POST", "/auth/login", { body: { email: m.email, password, organizationSlug: slug } });
  return { org, m, login };
}

describe("my sessions", () => {
  it("lists only the caller's active sessions in this organization and revokes another one", async () => {
    const { m, login } = await member();
    const a = (await login()).body.token as string;
    const b = (await login()).body.token as string;
    const other = await member(); // someone else's session must never show up
    await other.login();

    const list = await api.call("GET", "/auth/sessions", { token: a });
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    const target = list.body.items.find((s: { current: boolean }) => !s.current).id as string;
    expect((await api.call("DELETE", `/auth/sessions/${target}`, { token: a })).status).toBe(204);
    expect((await api.call("GET", "/me", { token: b })).status).toBe(401); // the revoked one (b was the other session)
    expect((await api.call("DELETE", `/auth/sessions/${target}`, { token: a })).status).toBe(404); // already revoked
    const own = list.body.items.find((s: { current: boolean }) => s.current).id as string;
    expect((await api.call("DELETE", `/auth/sessions/${own}`, { token: a })).status).toBe(409); // current: use logout
    expect((await api.call("DELETE", `/auth/sessions/${randomUUID()}`, { token: a })).status).toBe(404);
    expect((await api.call("DELETE", "/auth/sessions/not-a-uuid", { token: a })).status).toBe(400);
    expect((await api.call("GET", "/auth/sessions")).status).toBe(401);
    const audit = await owner.query("SELECT 1 FROM audit_events WHERE actor_user_id = $1 AND action = 'auth.session_revoked'", [m.userId]);
    expect(audit.rowCount).toBe(1);
  });

  it("cannot revoke another user's session even knowing its id", async () => {
    const { login } = await member();
    const mine = (await login()).body.token as string;
    const victim = await member();
    const victimToken = (await victim.login()).body.token as string;
    const victimSession = (await api.call("GET", "/auth/sessions", { token: victimToken })).body.items[0].id as string;
    expect((await api.call("DELETE", `/auth/sessions/${victimSession}`, { token: mine })).status).toBe(404);
    expect((await api.call("GET", "/me", { token: victimToken })).status).toBe(200);
  });
});

describe("change password", () => {
  it("rotates the hash, keeps the current session and revokes the others in every organization", async () => {
    const { org, m, login } = await member();
    const second = await seedOrganization(`acc2-${randomUUID().slice(0, 6)}`);
    await owner.query("INSERT INTO memberships (id, organization_id, user_id, role, updated_at) VALUES ($1,$2,$3,'seller', now())", [randomUUID(), second.id, m.userId]);
    const current = (await login()).body.token as string;
    const sameOrg = (await login()).body.token as string;
    const otherOrg = (await login(second.slug)).body.token as string;

    const res = await api.call("POST", "/auth/change-password", { token: current, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revokedSessions: 2 });
    expect((await api.call("GET", "/me", { token: current })).status).toBe(200);
    expect((await api.call("GET", "/me", { token: sameOrg })).status).toBe(401);
    expect((await api.call("GET", "/me", { token: otherOrg })).status).toBe(401);
    expect((await login(org.slug, PASSWORD)).status).toBe(401); // old password is dead
    expect((await login(org.slug, NEW_PASSWORD)).status).toBe(200);
    const audit = await owner.query("SELECT metadata FROM audit_events WHERE actor_user_id = $1 AND action = 'auth.password_changed'", [m.userId]);
    expect(audit.rows[0].metadata).toEqual({ revokedSessions: 2 });
    expect(JSON.stringify(audit.rows)).not.toContain(NEW_PASSWORD);
  });

  it("refuses a wrong current password, a weak new one and unknown fields, and keeps everything intact", async () => {
    const { login } = await member();
    const token = (await login()).body.token as string;
    const other = (await login()).body.token as string;
    expect((await api.call("POST", "/auth/change-password", { token, body: { currentPassword: "not the password", newPassword: NEW_PASSWORD } })).status).toBe(403);
    expect((await api.call("POST", "/auth/change-password", { token, body: { currentPassword: PASSWORD, newPassword: "short" } })).status).toBe(400);
    expect((await api.call("POST", "/auth/change-password", { token, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, userId: randomUUID() } })).status).toBe(400);
    expect((await api.call("POST", "/auth/change-password", { body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } })).status).toBe(401);
    expect((await api.call("GET", "/me", { token: other })).status).toBe(200); // nothing was revoked
  });

  it("is throttled like login so a stolen session cannot guess the password", async () => {
    const { login } = await member();
    const token = (await login()).body.token as string;
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await api.call("POST", "/auth/change-password", { token, body: { currentPassword: `wrong password ${i}`, newPassword: NEW_PASSWORD } })).status);
    expect(statuses.slice(0, 4)).toEqual([403, 403, 403, 403]);
    expect(statuses).toContain(429);
    // even the right password is refused while blocked
    expect((await api.call("POST", "/auth/change-password", { token, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } })).status).toBe(429);
  });

  it("the runtime role cannot call the function without a tenant session and cannot read hashes", async () => {
    const rows = await owner.query("SELECT has_function_privilege('app_runtime', 'auth_change_password(uuid,text,uuid)', 'EXECUTE') AS ok, has_function_privilege('public', 'auth_change_password(uuid,text,uuid)', 'EXECUTE') AS pub");
    expect(rows.rows[0]).toEqual({ ok: true, pub: false });
    const col = await owner.query("SELECT has_column_privilege('app_runtime', 'users', 'password_hash', 'SELECT') AS r, has_column_privilege('app_runtime', 'users', 'password_hash', 'UPDATE') AS w");
    expect(col.rows[0]).toEqual({ r: false, w: false });
  });
});

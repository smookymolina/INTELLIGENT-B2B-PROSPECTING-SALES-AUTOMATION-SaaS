import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MembershipRole } from "@prospecting/contracts";
import { NotificationsService, type NotifyInput } from "../notifications/notifications.service.js";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** F9: in-app notification inbox. Per-user visibility is enforced by RLS (organization + recipient). */
let api: Api;
let svc: NotificationsService;
type Account = { token: string; orgId: string; userId: string };

async function register(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label}` } });
  const me = await api.call("GET", "/me", { token: res.body.token });
  return { token: res.body.token, orgId: res.body.organization.id, userId: me.body.user.id };
}
async function member(orgId: string, role: MembershipRole) {
  const m = await seedMember(orgId, role);
  const token = (await api.call("POST", "/auth/login", { body: { email: m.email, password: PASSWORD } })).body.token as string;
  return { token, userId: m.userId };
}
const ctx = (a: { orgId: string; userId: string }, role: MembershipRole = "org_admin") => ({ organizationId: a.orgId, userId: a.userId, role });
const input = (userId: string, over: Partial<NotifyInput> = {}): NotifyInput => ({
  userId, type: "lead_assigned", title: "Lead asignado", dedupeKey: `k-${randomUUID()}`, ...over,
});

beforeAll(async () => {
  api = await startApi();
  svc = api.app.get(NotificationsService);
});
afterAll(async () => {
  await api.close();
});

describe("notifications", () => {
  it("requires a session", async () => {
    for (const [m, p] of [["GET", "/notifications"], ["GET", "/notifications/unread-count"], ["POST", "/notifications/read-all"], ["GET", "/notifications/preferences"]] as const) {
      expect((await api.call(m, p)).status).toBe(401);
    }
  });

  it("creates idempotently per event and user", async () => {
    const a = await register("notif-idem");
    const key = `lead-assigned:${randomUUID()}`;
    expect(await svc.notify(ctx(a), input(a.userId, { dedupeKey: key }))).toBe(true);
    expect(await svc.notify(ctx(a), input(a.userId, { dedupeKey: key }))).toBe(false);
    const rows = await owner.query("SELECT channel FROM notifications WHERE organization_id = $1 AND user_id = $2", [a.orgId, a.userId]);
    expect(rows.rows).toEqual([{ channel: "sandbox" }]);
    expect((await api.call("GET", "/notifications/unread-count", { token: a.token })).body).toEqual({ unread: 1 });
  });

  it("lists paginated, filters unread, marks one and all read", async () => {
    const a = await register("notif-list");
    for (let i = 0; i < 5; i++) await svc.notify(ctx(a), input(a.userId, { title: `N${i}`, resourceType: "lead", resourceId: randomUUID() }));
    const p1 = await api.call("GET", "/notifications?limit=2", { token: a.token });
    expect(p1.status).toBe(200);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await api.call("GET", `/notifications?limit=2&cursor=${p1.body.nextCursor}`, { token: a.token });
    const p3 = await api.call("GET", `/notifications?limit=2&cursor=${p2.body.nextCursor}`, { token: a.token });
    const ids = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((n: { id: string }) => n.id);
    expect(new Set(ids).size).toBe(5);
    expect(p3.body.nextCursor).toBeNull();
    expect(p1.body.items[0]).toMatchObject({ type: "lead_assigned", channel: "sandbox", readAt: null });

    const one = await api.call("POST", `/notifications/${ids[0]}/read`, { token: a.token });
    expect(one.status).toBe(200);
    expect(one.body.readAt).toBeTruthy();
    const again = await api.call("POST", `/notifications/${ids[0]}/read`, { token: a.token });
    expect(again.body.readAt).toBe(one.body.readAt);
    expect((await api.call("GET", "/notifications/unread-count", { token: a.token })).body.unread).toBe(4);
    expect((await api.call("GET", "/notifications?unread=true", { token: a.token })).body.items).toHaveLength(4);

    expect((await api.call("POST", "/notifications/read-all", { token: a.token })).body).toEqual({ updated: 4 });
    expect((await api.call("GET", "/notifications/unread-count", { token: a.token })).body.unread).toBe(0);
    expect((await api.call("GET", "/notifications?unread=true", { token: a.token })).body.items).toHaveLength(0);
  });

  it("a user never sees or touches a colleague's notifications in the same organization", async () => {
    const a = await register("notif-own");
    const b = await member(a.orgId, "seller");
    await svc.notify(ctx(a), input(b.userId, { title: "Para B" }));
    await svc.notify(ctx(a), input(a.userId, { title: "Para A" }));
    const bList = await api.call("GET", "/notifications", { token: b.token });
    expect(bList.body.items.map((n: { title: string }) => n.title)).toEqual(["Para B"]);
    const aList = await api.call("GET", "/notifications", { token: a.token });
    expect(aList.body.items.map((n: { title: string }) => n.title)).toEqual(["Para A"]);
    const bId = bList.body.items[0].id as string;
    expect((await api.call("POST", `/notifications/${bId}/read`, { token: a.token })).status).toBe(404);
    expect((await api.call("GET", `/notifications?cursor=${bId}`, { token: a.token })).status).toBe(404);
    expect((await api.call("POST", "/notifications/read-all", { token: a.token })).body).toEqual({ updated: 1 });
    expect((await api.call("GET", "/notifications/unread-count", { token: b.token })).body.unread).toBe(1);
    // Database level: a direct update as A on B's row touches nothing.
    const r = await asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, (c) => c.query("UPDATE notifications SET read_at = now() WHERE id = $1", [bId]));
    expect(r.rowCount).toBe(0);
  });

  it("does not generate notifications for disabled types and audits the change", async () => {
    const a = await register("notif-pref");
    const defaults = await api.call("GET", "/notifications/preferences", { token: a.token });
    expect(defaults.body.items).toHaveLength(6);
    expect(defaults.body.items.every((p: { enabled: boolean }) => p.enabled)).toBe(true);

    const set = await api.call("PUT", "/notifications/preferences", { token: a.token, body: { preferences: [{ type: "sla_breached", enabled: false }] } });
    expect(set.status).toBe(200);
    expect(set.body.items.find((p: { type: string }) => p.type === "sla_breached").enabled).toBe(false);
    expect(await svc.notify(ctx(a), input(a.userId, { type: "sla_breached" }))).toBe(false);
    expect(await svc.notify(ctx(a), input(a.userId, { type: "lead_assigned" }))).toBe(true);

    await api.call("PUT", "/notifications/preferences", { token: a.token, body: { preferences: [{ type: "sla_breached", enabled: true }] } });
    expect(await svc.notify(ctx(a), input(a.userId, { type: "sla_breached" }))).toBe(true);
    const audit = await owner.query("SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1 AND action = 'notification.preferences_updated'", [a.orgId]);
    expect(audit.rows[0].n).toBe(2);
    expect((await api.call("PUT", "/notifications/preferences", { token: a.token, body: { preferences: [{ type: "nope", enabled: true }] } })).status).toBe(400);
  });

  it("scanDue emits overdue and due-soon task notifications once", async () => {
    const a = await register("notif-scan");
    const p = (await api.call("POST", "/prospects", { token: a.token, body: { name: "Co scan", domain: `sc-${randomUUID().slice(0, 8)}.example` } })).body as { id: string };
    const r = await api.call("POST", `/prospects/${p.id}/replies`, { token: a.token, body: { text: "Queremos comprar 10 unidades" } });
    const leadId = r.body.effects.leadId as string;
    await api.call("POST", `/leads/${leadId}/decision`, { token: a.token, body: { decision: "accept" } });
    const oid = (await api.call("POST", "/opportunities", { token: a.token, body: { leadId, title: "Venta" } })).body.id as string;
    const hour = 3_600_000;
    await api.call("POST", `/opportunities/${oid}/tasks`, { token: a.token, body: { title: "Vieja", dueAt: new Date(Date.now() - hour).toISOString() } });
    await api.call("POST", `/opportunities/${oid}/tasks`, { token: a.token, body: { title: "Pronta", dueAt: new Date(Date.now() + 2 * hour).toISOString() } });
    await api.call("POST", `/opportunities/${oid}/tasks`, { token: a.token, body: { title: "Lejana", dueAt: new Date(Date.now() + 10 * 24 * hour).toISOString() } });

    expect(await svc.scanDue(ctx(a))).toEqual({ overdue: 1, dueSoon: 1 });
    expect(await svc.scanDue(ctx(a))).toEqual({ overdue: 0, dueSoon: 0 });
    const list = await api.call("GET", "/notifications", { token: a.token });
    // The lead behind the opportunity raises its own `lead_assigned` notice; only the task notices belong to scanDue.
    const taskTypes = list.body.items.map((n: { type: string }) => n.type).filter((t: string) => t.startsWith("task_"));
    expect(taskTypes.sort()).toEqual(["task_due_soon", "task_overdue"]);
  });

  it("rejects a recipient outside the organization", async () => {
    const a = await register("notif-out-a");
    const b = await register("notif-out-b");
    await expect(svc.notify(ctx(a), input(b.userId))).rejects.toMatchObject({ status: 409 });
  });

  it("isolates tenants through RLS", async () => {
    const a = await register("notif-iso-a");
    const b = await register("notif-iso-b");
    await svc.notify(ctx(a), input(a.userId));
    expect((await api.call("GET", "/notifications", { token: b.token })).body.items).toHaveLength(0);
    const seen = await asRuntime({ organizationId: b.orgId, userId: b.userId, role: "org_admin" }, (c) => c.query("SELECT id FROM notifications"));
    expect(seen.rowCount).toBe(0);
    // Even the same user id under another organization context sees nothing, and cannot insert into the other org.
    const cross = await asRuntime({ organizationId: b.orgId, userId: a.userId, role: "org_admin" }, (c) => c.query("SELECT id FROM notifications"));
    expect(cross.rowCount).toBe(0);
    await expect(
      asRuntime({ organizationId: b.orgId, userId: b.userId, role: "org_admin" }, (c) =>
        c.query("INSERT INTO notifications (organization_id, user_id, type, title, dedupe_key) VALUES ($1, $2, 'lead_assigned', 'x', 'x')", [a.orgId, a.userId]),
      ),
    ).rejects.toThrow(/row-level security|not a member/);
  });
});

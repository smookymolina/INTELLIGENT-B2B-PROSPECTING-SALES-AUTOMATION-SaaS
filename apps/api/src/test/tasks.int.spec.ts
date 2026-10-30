import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MembershipRole } from "@prospecting/contracts";
import { type Api, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** P9-02: follow-up tasks. Visibility and the open -> done/cancelled machine are enforced by PostgreSQL. */
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
  const token = (await api.call("POST", "/auth/login", { body: { email: m.email, password: PASSWORD } })).body.token as string;
  return { token, userId: m.userId };
}
async function opportunity(t: string, title = "Venta de bombas") {
  const p = (await api.call("POST", "/prospects", { token: t, body: { name: `Co ${randomUUID().slice(0, 6)}`, domain: `tk-${randomUUID().slice(0, 8)}.example` } })).body as { id: string };
  const r = await api.call("POST", `/prospects/${p.id}/replies`, { token: t, body: { text: "Queremos comprar 10 unidades" } });
  const leadId = r.body.effects.leadId as string;
  await api.call("POST", `/leads/${leadId}/decision`, { token: t, body: { decision: "accept" } });
  return (await api.call("POST", "/opportunities", { token: t, body: { leadId, title } })).body.id as string;
}
const assign = (t: string, oid: string, userId: string | null) => api.call("POST", `/opportunities/${oid}/assign`, { token: t, body: { userId } });
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const addTask = (t: string, oid: string, over: Record<string, unknown> = {}) => api.call("POST", `/opportunities/${oid}/tasks`, { token: t, body: { title: "Llamar al cliente", dueAt: at(DAY), ...over } });

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("task lifecycle", () => {
  it("creates, lists, completes with database-stamped time and user, and refuses to reopen", async () => {
    const a = await register("task-life");
    const oid = await opportunity(a.token);
    const created = await addTask(a.token, oid);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ opportunityId: oid, title: "Llamar al cliente", state: "open", assigneeUserId: a.userId, createdBy: a.userId, completedAt: null, overdue: false });

    const list = await api.call("GET", `/opportunities/${oid}/tasks`, { token: a.token });
    expect(list.body.items.map((t: { id: string }) => t.id)).toEqual([created.body.id]);
    expect((await api.call("GET", "/tasks", { token: a.token })).body.items).toHaveLength(1);

    const done = await api.call("POST", `/tasks/${created.body.id}/complete`, { token: a.token });
    expect(done.status).toBe(200);
    expect(done.body.state).toBe("done");
    expect(done.body.completedAt).toBeTruthy();
    const row = await owner.query("SELECT completed_by, completed_at FROM opportunity_tasks WHERE id = $1", [created.body.id]);
    expect(row.rows[0].completed_by).toBe(a.userId);
    expect((await api.call("POST", `/tasks/${created.body.id}/complete`, { token: a.token })).status).toBe(409);
    expect((await api.call("POST", `/tasks/${created.body.id}/cancel`, { token: a.token })).status).toBe(409);
    expect((await api.call("GET", "/tasks", { token: a.token })).body.items).toHaveLength(0); // default filter: open
    expect((await api.call("GET", "/tasks?state=done", { token: a.token })).body.items).toHaveLength(1);

    const second = await addTask(a.token, oid, { title: "Enviar ficha" });
    expect((await api.call("POST", `/tasks/${second.body.id}/cancel`, { token: a.token })).body.state).toBe("cancelled");
    const audit = await owner.query("SELECT action FROM audit_events WHERE organization_id = $1 AND action LIKE 'task.%' ORDER BY created_at", [a.orgId]);
    expect(audit.rows.map((r) => r.action)).toEqual(["task.created", "task.completed", "task.created", "task.cancelled"]);
  });

  it("orders by due date with keyset pagination and flags overdue tasks", async () => {
    const a = await register("task-order");
    const oid = await opportunity(a.token);
    const late = (await addTask(a.token, oid, { title: "tarde", dueAt: at(3 * DAY) })).body.id as string;
    const past = (await addTask(a.token, oid, { title: "vencida", dueAt: at(-DAY) })).body.id as string;
    const soon = (await addTask(a.token, oid, { title: "pronto", dueAt: at(DAY) })).body.id as string;

    const p1 = await api.call("GET", "/tasks?limit=2", { token: a.token });
    expect(p1.body.items.map((t: { id: string }) => t.id)).toEqual([past, soon]);
    expect(p1.body.items[0].overdue).toBe(true);
    expect(p1.body.items[1].overdue).toBe(false);
    const p2 = await api.call("GET", `/tasks?limit=2&cursor=${p1.body.nextCursor}`, { token: a.token });
    expect(p2.body.items.map((t: { id: string }) => t.id)).toEqual([late]);
    expect(p2.body.nextCursor).toBeNull();
    expect((await api.call("GET", "/tasks?overdue=true", { token: a.token })).body.items.map((t: { id: string }) => t.id)).toEqual([past]);
    expect((await api.call("GET", `/tasks?cursor=${randomUUID()}`, { token: a.token })).status).toBe(404);
  });

  it("validates input strictly and refuses closed opportunities and invalid assignees", async () => {
    const a = await register("task-valid");
    const oid = await opportunity(a.token);
    for (const body of [{ title: "", dueAt: at(DAY) }, { title: "x", dueAt: "tomorrow" }, { title: "x" }, { title: "x", dueAt: at(DAY), state: "done" }, { title: "x", dueAt: at(DAY), organizationId: randomUUID() }]) {
      expect((await api.call("POST", `/opportunities/${oid}/tasks`, { token: a.token, body })).status).toBe(400);
    }
    expect((await addTask(a.token, randomUUID())).status).toBe(404);
    const viewer = await member(a.orgId, "viewer");
    expect((await addTask(a.token, oid, { assigneeUserId: viewer.userId })).status).toBe(409); // not a seller/manager/admin
    expect((await addTask(a.token, oid, { assigneeUserId: randomUUID() })).status).toBe(409);
    expect((await api.call("GET", "/tasks?state=bogus", { token: a.token })).status).toBe(400);

    const open = (await addTask(a.token, oid)).body.id as string;
    expect((await api.call("POST", `/opportunities/${oid}/stage`, { token: a.token, body: { stage: "lost", lossReason: "sin presupuesto" } })).status).toBe(200);
    expect((await addTask(a.token, oid)).status).toBe(409); // closed opportunity
    expect((await api.call("POST", `/tasks/${open}/complete`, { token: a.token })).status).toBe(200); // pending tasks can still be wrapped up
  });
});

describe("visibility and rights", () => {
  it("sellers only see and work tasks of their own opportunities and can only assign themselves", async () => {
    const a = await register("task-rls");
    const s1 = await member(a.orgId, "seller");
    const s2 = await member(a.orgId, "seller");
    const o1 = await opportunity(a.token, "De uno");
    const o2 = await opportunity(a.token, "De dos");
    await assign(a.token, o1, s1.userId);
    await assign(a.token, o2, s2.userId);

    const t1 = (await addTask(s1.token, o1)).body;
    expect(t1.assigneeUserId).toBe(s1.userId);
    const t2 = (await addTask(a.token, o2, { title: "del vendedor dos" })).body; // assignee defaults to the owner
    expect(t2.assigneeUserId).toBe(s2.userId);

    expect((await api.call("GET", "/tasks", { token: s1.token })).body.items.map((t: { id: string }) => t.id)).toEqual([t1.id]);
    expect((await api.call("GET", "/tasks", { token: a.token })).body.items).toHaveLength(2);
    expect((await api.call("GET", "/tasks?assignee=me", { token: s2.token })).body.items.map((t: { id: string }) => t.id)).toEqual([t2.id]);
    expect((await addTask(s1.token, o2)).status).toBe(404); // not theirs: invisible
    expect((await api.call("GET", `/opportunities/${o2}/tasks`, { token: s1.token })).body.items).toEqual([]);
    expect((await api.call("POST", `/tasks/${t2.id}/complete`, { token: s1.token })).status).toBe(404);
    expect((await addTask(s1.token, o1, { assigneeUserId: s2.userId })).status).toBe(403); // sellers assign only themselves
    expect((await api.call("POST", `/tasks/${t1.id}/complete`, { token: s1.token })).status).toBe(200);
    expect((await api.call("GET", `/tasks/${t2.id}`, { token: s1.token })).status).toBe(404);
  });

  it("read-only roles list but cannot create or close, and other organizations see nothing", async () => {
    const a = await register("task-roles");
    const oid = await opportunity(a.token);
    const task = (await addTask(a.token, oid)).body;
    const reader = await member(a.orgId, "campaign_manager"); // crm:read, no crm:work
    expect((await api.call("GET", "/tasks", { token: reader.token })).body.items).toHaveLength(1);
    expect((await addTask(reader.token, oid)).status).toBe(403);
    expect((await api.call("POST", `/tasks/${task.id}/complete`, { token: reader.token })).status).toBe(403);
    const viewer = await member(a.orgId, "viewer");
    expect((await api.call("GET", "/tasks", { token: viewer.token })).status).toBe(200); // viewers hold crm:read
    expect((await addTask(viewer.token, oid)).status).toBe(403);

    const other = await register("task-other");
    expect((await api.call("GET", "/tasks", { token: other.token })).body.items).toEqual([]);
    expect((await api.call("POST", `/tasks/${task.id}/complete`, { token: other.token })).status).toBe(404);
    expect((await addTask(other.token, oid)).status).toBe(404);
    expect((await api.call("GET", "/tasks")).status).toBe(401);
  });

  it("the database refuses tampering that bypasses the API (closed tasks, foreign tenants)", async () => {
    const a = await register("task-db");
    const oid = await opportunity(a.token);
    const task = (await addTask(a.token, oid)).body;
    await api.call("POST", `/tasks/${task.id}/complete`, { token: a.token });
    await expect(owner.query("UPDATE opportunity_tasks SET state = 'open' WHERE id = $1", [task.id])).rejects.toThrow(/closed task cannot change|task_completion/);
    await expect(owner.query("INSERT INTO opportunity_tasks (organization_id, opportunity_id, title, due_at, assignee_user_id, created_by, state) VALUES ($1,$2,'x',now(),$3,$3,'done')", [a.orgId, oid, a.userId])).rejects.toThrow();
  });
});

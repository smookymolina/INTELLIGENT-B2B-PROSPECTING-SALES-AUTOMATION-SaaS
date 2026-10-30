import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMBERSHIP_ROLES, OPPORTUNITY_STAGES, OPPORTUNITY_TRANSITIONS, OpportunityDetailDto, type MembershipRole } from "@prospecting/contracts";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** P9-01: pipeline, stage machine, trigger-written history, routing (manual / round-robin / queue), SLA, seller visibility by RLS. */
let api: Api;
type Account = { token: string; orgId: string; userId: string };

async function register(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label}` } });
  const me = await api.call("GET", "/me", { token: res.body.token });
  return { token: res.body.token, orgId: res.body.organization.id, userId: me.body.user.id };
}
async function member(orgId: string, role: MembershipRole, label?: string) {
  const m = await seedMember(orgId, role, label);
  const token = (await api.call("POST", "/auth/login", { body: { email: m.email, password: PASSWORD } })).body.token as string;
  return { token, userId: m.userId };
}
/** A prospect with an ACCEPTED lead (positive reply -> pending lead -> human acceptance). */
async function acceptedLead(t: string, over: Record<string, unknown> = {}) {
  const p = (await api.call("POST", "/prospects", { token: t, body: { name: `Co ${randomUUID().slice(0, 6)}`, domain: `crm-${randomUUID().slice(0, 8)}.example`, ...over } })).body as { id: string; domain: string };
  const r = await api.call("POST", `/prospects/${p.id}/replies`, { token: t, body: { text: "Queremos comprar 10 unidades" } });
  const leadId = r.body.effects.leadId as string;
  await api.call("POST", `/leads/${leadId}/decision`, { token: t, body: { decision: "accept" } });
  return { leadId, prospect: p };
}
const create = async (t: string, over: Record<string, unknown> = {}) => {
  const { leadId } = await acceptedLead(t);
  return api.call("POST", "/opportunities", { token: t, body: { leadId, title: "Venta de bombas", ...over } });
};
const stage = (t: string, id: string, to: string, extra: Record<string, unknown> = {}) => api.call("POST", `/opportunities/${id}/stage`, { token: t, body: { stage: to, ...extra } });
const get = (t: string, id: string) => api.call("GET", `/opportunities/${id}`, { token: t });
const pool = (t: string, userId: string, maxOpen = 2, active = true) => api.call("PUT", `/routing/pool/${userId}`, { token: t, body: { active, maxOpen } });
const settings = (t: string, strategy: string, firstResponseSlaMinutes: number | null = null) => api.call("PUT", "/routing/settings", { token: t, body: { strategy, firstResponseSlaMinutes } });

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("creating opportunities", () => {
  it("needs an ACCEPTED lead, one opportunity per lead, and never for suppressed prospects", async () => {
    const a = await register("create");
    const p = (await api.call("POST", "/prospects", { token: a.token, body: { name: "Pending Co", domain: `pend-${randomUUID().slice(0, 6)}.example` } })).body;
    const r = await api.call("POST", `/prospects/${p.id}/replies`, { token: a.token, body: { text: "Queremos comprar" } });
    const pendingLead = r.body.effects.leadId as string;
    expect((await api.call("POST", "/opportunities", { token: a.token, body: { leadId: pendingLead, title: "x" } })).status).toBe(409); // not accepted yet
    expect((await api.call("POST", "/opportunities", { token: a.token, body: { leadId: randomUUID(), title: "x" } })).status).toBe(404);

    const ok = await create(a.token, { expectedValue: "1500.5", currency: "MXN" });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ stage: "new", ownerUserId: null, expectedValue: "1500.5000", currency: "MXN", slaBreached: null, closedAt: null });
    const dup = await api.call("POST", "/opportunities", { token: a.token, body: { leadId: ok.body.leadId, title: "again" } });
    expect(dup.status).toBe(409);

    const { leadId, prospect } = await acceptedLead(a.token);
    await api.call("POST", "/suppressions", { token: a.token, body: { kind: "domain", value: prospect.domain, reason: "opt-out" } });
    expect((await api.call("POST", "/opportunities", { token: a.token, body: { leadId, title: "x" } })).status).toBe(409);
    for (const body of [{ leadId, title: "" }, { leadId, title: "x", expectedValue: "10" }, { leadId, title: "x", currency: "MXN" }, { leadId, title: "x", stage: "won" }, { leadId, title: "x", organization_id: randomUUID() }]) {
      expect((await api.call("POST", "/opportunities", { token: a.token, body })).status).toBe(400);
    }
  });
});

describe("stage machine and timeline", () => {
  it("the contract table of transitions matches the database function for every pair of stages", async () => {
    for (const from of OPPORTUNITY_STAGES) {
      for (const to of OPPORTUNITY_STAGES) {
        const { rows } = await owner.query("SELECT crm_stage_allowed($1, $2) AS ok", [from, to]);
        expect(rows[0].ok, `${from} -> ${to}`).toBe((OPPORTUNITY_TRANSITIONS[from] as readonly string[]).includes(to));
      }
    }
  });

  it("walks the valid path, stamps first contact and closing, and keeps every step in an immutable history", async () => {
    const a = await register("stages");
    const opp = (await create(a.token)).body.id as string;
    expect((await stage(a.token, opp, "won")).status).toBe(409); // cannot skip
    expect((await stage(a.token, opp, "negotiation")).status).toBe(409);
    const contacted = await stage(a.token, opp, "contacted", { note: "primer llamado" });
    expect(contacted.body.firstContactedAt).toBeTruthy();
    for (const to of ["qualification", "quote_requested", "quote_sent", "negotiation", "won"]) expect((await stage(a.token, opp, to)).status).toBe(200);
    const won = await get(a.token, opp);
    expect(OpportunityDetailDto.safeParse(won.body).success).toBe(true);
    expect(won.body).toMatchObject({ stage: "won" });
    expect(won.body.closedAt).toBeTruthy();
    const steps = won.body.timeline.filter((t: { kind: string }) => t.kind === "stage").map((t: { from: string | null; to: string }) => [t.from, t.to]);
    expect(steps).toEqual([[null, "new"], ["new", "contacted"], ["contacted", "qualification"], ["qualification", "quote_requested"], ["quote_requested", "quote_sent"], ["quote_sent", "negotiation"], ["negotiation", "won"]]);
    expect(won.body.timeline.find((t: { note?: string }) => t.note === "primer llamado")).toBeTruthy();

    expect((await stage(a.token, opp, "contacted")).status).toBe(409); // closed
    expect((await api.call("POST", `/opportunities/${opp}/notes`, { token: a.token, body: { kind: "note", body: "cliente satisfecho" } })).status).toBe(201); // notes still allowed
    const ctx = { organizationId: a.orgId, userId: a.userId, role: "org_admin" };
    const denied = (sql: string, params: unknown[] = []) => asRuntime(ctx, async (c) => c.query(sql, params).then(() => "NO ERROR", (e: Error) => e.message));
    expect(await denied("UPDATE opportunity_stage_history SET to_stage = 'lost'")).toMatch(/permission denied/);
    expect(await denied("DELETE FROM opportunity_stage_history")).toMatch(/permission denied/);
    expect(await denied("INSERT INTO opportunity_stage_history (organization_id, opportunity_id, to_stage) VALUES ($1,$2,'won')", [a.orgId, opp])).toMatch(/permission denied/);
    expect(await denied("UPDATE opportunities SET stage = 'new' WHERE id = $1", [opp])).toMatch(/invalid stage transition/);
    await expect(owner.query("UPDATE opportunities SET title = 'x' WHERE id = $1", [opp])).rejects.toThrow(/immutable/);
  });

  it("loss needs a reason (and only loss), future can come back, closed cannot be reassigned", async () => {
    const a = await register("lost");
    const opp = (await create(a.token)).body.id as string;
    expect((await stage(a.token, opp, "lost")).status).toBe(400);
    expect((await stage(a.token, opp, "contacted", { lossReason: "x" })).status).toBe(400);
    expect((await stage(a.token, opp, "future")).body.stage).toBe("future");
    expect((await stage(a.token, opp, "contacted")).body.stage).toBe("contacted");
    const lost = await stage(a.token, opp, "lost", { lossReason: "compró con otro proveedor" });
    expect(lost.body).toMatchObject({ stage: "lost", lossReason: "compró con otro proveedor" });
    expect((await api.call("POST", `/opportunities/${opp}/assign`, { token: a.token, body: { userId: null } })).status).toBe(409);
    for (const body of [{ stage: "bogus" }, {}, { stage: "won", extra: 1 }]) expect((await api.call("POST", `/opportunities/${opp}/stage`, { token: a.token, body })).status).toBe(400);
  });

  it("logs notes and activities on the timeline", async () => {
    const a = await register("notes");
    const opp = (await create(a.token)).body.id as string;
    const res = await api.call("POST", `/opportunities/${opp}/notes`, { token: a.token, body: { kind: "call", body: "Llamada de 10 min" } });
    expect(res.body.timeline.at(-1)).toMatchObject({ kind: "note", noteKind: "call", body: "Llamada de 10 min" });
    for (const body of [{ kind: "sms", body: "x" }, { kind: "note", body: "" }, { kind: "note", body: "x".repeat(2001) }]) expect((await api.call("POST", `/opportunities/${opp}/notes`, { token: a.token, body })).status).toBe(400);
  });
});

describe("routing", () => {
  it("defaults to manual with no SLA; round-robin respects capacity, is reproducible, falls back to the queue", async () => {
    const a = await register("rr");
    const s1 = await member(a.orgId, "seller", "ana");
    const s2 = await member(a.orgId, "seller", "beto");
    const viewer = await member(a.orgId, "viewer");
    expect((await api.call("GET", "/routing/settings", { token: a.token })).body).toEqual({ strategy: "manual", firstResponseSlaMinutes: null });
    expect((await pool(a.token, viewer.userId)).status).toBe(409); // viewers cannot own opportunities
    expect((await pool(a.token, randomUUID())).status).toBe(409);
    await pool(a.token, s1.userId, 1);
    await pool(a.token, s2.userId, 2);
    expect((await api.call("GET", "/routing/pool", { token: a.token })).body.items).toHaveLength(2);
    expect((await settings(a.token, "round_robin", 60)).body).toEqual({ strategy: "round_robin", firstResponseSlaMinutes: 60 });

    const owners: Array<string | null> = [];
    for (let i = 0; i < 4; i++) owners.push((await create(a.token)).body.ownerUserId);
    const [first, second] = [s1.userId, s2.userId].sort(); // ties break by user id
    expect(owners[0]).toBe(first);
    expect(owners[1]).toBe(second);
    expect(owners[2]).toBe(s2.userId); // s1 is at capacity (1), s2 has room (2)
    expect(owners[3]).toBeNull(); // nobody eligible: unassigned queue
    const queued = await api.call("GET", "/opportunities?owner=unassigned", { token: a.token });
    expect(queued.body.items).toHaveLength(1);

    const row = (await owner.query("SELECT strategy, candidates FROM opportunity_assignments WHERE organization_id = $1 AND assigned_to IS NULL", [a.orgId])).rows[0];
    expect(row.strategy).toBe("queue");
    expect(row.candidates.map((c: { eligible: boolean }) => c.eligible)).toEqual([false, false]); // the snapshot explains why
    const first1 = (await api.call("GET", "/opportunities?limit=100", { token: a.token })).body.items.find((o: { ownerUserId: string | null }) => o.ownerUserId === owners[0]);
    expect(new Date(first1.firstResponseDueAt).getTime() - new Date(first1.assignedAt).getTime()).toBe(60 * 60_000);

    // capacity frees up -> auto-assign the queued one
    const open = (await api.call("GET", "/opportunities?limit=100", { token: a.token })).body.items.find((o: { ownerUserId: string | null }) => o.ownerUserId === s1.userId);
    await stage(a.token, open.id, "lost", { lossReason: "sin interés" });
    const queuedId = queued.body.items[0].id as string;
    expect((await api.call("POST", `/opportunities/${queuedId}/auto-assign`, { token: a.token })).body.ownerUserId).toBe(s1.userId);
    expect((await pool(a.token, s2.userId, 2, false)).body.active).toBe(false);
    expect((await api.call("DELETE", `/routing/pool/${s2.userId}`, { token: a.token })).status).toBe(204);
    expect((await api.call("DELETE", `/routing/pool/${s2.userId}`, { token: a.token })).status).toBe(404);
  });

  it("manual assignment and reassignment keep the full history; the queue is reachable again", async () => {
    const a = await register("manual");
    const s1 = await member(a.orgId, "seller");
    const s2 = await member(a.orgId, "sales_manager");
    const viewer = await member(a.orgId, "viewer");
    const opp = (await create(a.token)).body.id as string;
    expect((await api.call("POST", `/opportunities/${opp}/assign`, { token: a.token, body: { userId: s1.userId } })).body.ownerUserId).toBe(s1.userId);
    expect((await api.call("POST", `/opportunities/${opp}/assign`, { token: a.token, body: { userId: s2.userId } })).body.ownerUserId).toBe(s2.userId);
    expect((await api.call("POST", `/opportunities/${opp}/assign`, { token: a.token, body: { userId: null } })).body).toMatchObject({ ownerUserId: null, assignedAt: null });
    expect((await api.call("POST", `/opportunities/${opp}/assign`, { token: a.token, body: { userId: viewer.userId } })).status).toBe(409);
    expect((await api.call("POST", `/opportunities/${opp}/assign`, { token: a.token, body: { userId: randomUUID() } })).status).toBe(409);
    const timeline = (await get(a.token, opp)).body.timeline.filter((t: { kind: string }) => t.kind === "assignment");
    expect(timeline.map((t: { strategy: string }) => t.strategy)).toEqual(["manual", "manual", "queue"]);
  });

  it("measures the first-response SLA", async () => {
    const a = await register("sla");
    const s1 = await member(a.orgId, "seller");
    await pool(a.token, s1.userId, 5);
    await settings(a.token, "round_robin", 30);
    const late = (await create(a.token)).body.id as string;
    const onTime = (await create(a.token)).body.id as string;
    const waiting = (await create(a.token)).body.id as string;
    expect((await get(a.token, late)).body.slaBreached).toBe(false);
    await owner.query("UPDATE opportunities SET first_response_due_at = now() - interval '1 hour' WHERE id = $1", [late]);
    expect((await get(a.token, late)).body.slaBreached).toBe(true); // deadline passed, nobody has contacted
    await stage(s1.token, late, "contacted");
    expect((await get(a.token, late)).body.slaBreached).toBe(true); // contacted after the deadline
    await stage(s1.token, onTime, "contacted");
    expect((await get(a.token, onTime)).body.slaBreached).toBe(false);
    expect((await get(a.token, waiting)).body.slaBreached).toBe(false);
    await settings(a.token, "manual", null);
    const noSla = (await create(a.token)).body;
    expect(noSla.slaBreached).toBeNull();
  });
});

describe("seller visibility (RLS) and permissions", () => {
  it("a seller sees, edits and logs only what is assigned to them", async () => {
    const a = await register("seller");
    const s1 = await member(a.orgId, "seller");
    const s2 = await member(a.orgId, "seller");
    const mine = (await create(a.token)).body.id as string;
    const theirs = (await create(a.token)).body.id as string;
    const unassigned = (await create(a.token)).body.id as string;
    await api.call("POST", `/opportunities/${mine}/assign`, { token: a.token, body: { userId: s1.userId } });
    await api.call("POST", `/opportunities/${theirs}/assign`, { token: a.token, body: { userId: s2.userId } });

    expect((await api.call("GET", "/opportunities", { token: s1.token })).body.items.map((o: { id: string }) => o.id)).toEqual([mine]);
    expect((await api.call("GET", "/opportunities/summary", { token: s1.token })).body).toMatchObject({ total: 1 });
    expect((await api.call("GET", "/opportunities/summary", { token: a.token })).body).toMatchObject({ total: 3 });
    for (const id of [theirs, unassigned]) {
      expect((await get(s1.token, id)).status).toBe(404);
      expect((await stage(s1.token, id, "contacted")).status).toBe(404);
      expect((await api.call("POST", `/opportunities/${id}/notes`, { token: s1.token, body: { kind: "note", body: "x" } })).status).toBe(404);
    }
    expect((await stage(s1.token, mine, "contacted")).status).toBe(200);
    expect((await api.call("POST", `/opportunities/${mine}/notes`, { token: s1.token, body: { kind: "call", body: "hablé con el cliente" } })).status).toBe(201);
    expect((await get(s1.token, mine)).body.timeline.map((t: { kind: string }) => t.kind)).toEqual(expect.arrayContaining(["stage", "note", "assignment"]));

    // managerial actions are refused by permission, and the database refuses them again by trigger/RLS
    expect((await api.call("POST", `/opportunities/${mine}/assign`, { token: s1.token, body: { userId: s2.userId } })).status).toBe(403);
    expect((await api.call("GET", "/routing/pool", { token: s1.token })).status).toBe(403);
    expect((await api.call("POST", "/opportunities", { token: s1.token, body: { leadId: randomUUID(), title: "x" } })).status).toBe(403);
    const ctx = { organizationId: a.orgId, userId: s1.userId, role: "seller" };
    await asRuntime(ctx, async (c) => {
      expect((await c.query("SELECT id FROM opportunities")).rows.map((r) => r.id)).toEqual([mine]);
      expect((await c.query("UPDATE opportunities SET title = 'x' WHERE id = $1", [theirs])).rowCount).toBe(0);
      expect((await c.query("SELECT 1 FROM opportunity_notes n WHERE n.opportunity_id = $1", [theirs])).rowCount).toBe(0);
    });
    const denied = (sql: string, params: unknown[] = []) => asRuntime(ctx, async (c) => c.query(sql, params).then(() => "NO ERROR", (e: Error) => e.message));
    expect(await denied("UPDATE opportunities SET owner_user_id = $2 WHERE id = $1", [mine, s2.userId])).toMatch(/only change the stage/);
    expect(await denied("UPDATE opportunities SET title = 'robado' WHERE id = $1", [mine])).toMatch(/only change the stage/);
    await asRuntime(ctx, async (c) => expect((await c.query("SELECT 1 FROM seller_pool")).rowCount).toBe(0));
  });
});

describe("RBAC matrix", () => {
  const expected: Record<MembershipRole, { read: number; work: number; manage: number }> = {
    org_admin: { read: 200, work: 200, manage: 200 },
    sales_manager: { read: 200, work: 200, manage: 200 },
    campaign_manager: { read: 200, work: 403, manage: 403 },
    seller: { read: 200, work: 200, manage: 403 }, // work applies to their own opportunities only
    analyst: { read: 200, work: 403, manage: 403 },
    viewer: { read: 200, work: 403, manage: 403 },
  };
  it("covers every role", () => expect(Object.keys(expected).sort()).toEqual([...MEMBERSHIP_ROLES].sort()));

  it.each(MEMBERSHIP_ROLES)("%s", async (role) => {
    const a = await register(`rbac-${role}`);
    const actor = role === "org_admin" ? { token: a.token, userId: a.userId } : await member(a.orgId, role);
    const opp = (await create(a.token)).body.id as string;
    if (role === "seller") await api.call("POST", `/opportunities/${opp}/assign`, { token: a.token, body: { userId: actor.userId } });
    const e = expected[role];
    expect((await api.call("GET", "/opportunities", { token: actor.token })).status).toBe(e.read);
    expect((await api.call("GET", "/opportunities/summary", { token: actor.token })).status).toBe(e.read);
    expect((await api.call("POST", `/opportunities/${opp}/notes`, { token: actor.token, body: { kind: "note", body: "n" } })).status).toBe(e.work === 200 ? 201 : 403);
    expect((await stage(actor.token, opp, "contacted")).status).toBe(e.work);
    expect((await api.call("GET", "/routing/settings", { token: actor.token })).status).toBe(e.manage);
    expect((await settings(actor.token, "manual")).status).toBe(e.manage);
    expect((await api.call("POST", `/opportunities/${opp}/auto-assign`, { token: actor.token })).status).toBe(e.manage);
    const { leadId } = await acceptedLead(a.token);
    expect((await api.call("POST", "/opportunities", { token: actor.token, body: { leadId, title: "x" } })).status).toBe(e.manage === 200 ? 201 : 403);
  });
});

describe("tenant isolation", () => {
  it("tenant B cannot see or act on A's pipeline, pool or leads", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    const s = await member(a.orgId, "seller");
    await pool(a.token, s.userId);
    const { leadId } = await acceptedLead(a.token);
    const opp = (await api.call("POST", "/opportunities", { token: a.token, body: { leadId, title: "A deal" } })).body.id as string;

    expect((await api.call("GET", "/opportunities", { token: b.token })).body.items).toEqual([]);
    expect((await api.call("GET", "/opportunities/summary", { token: b.token })).body.total).toBe(0);
    expect((await api.call("GET", "/routing/pool", { token: b.token })).body.items).toEqual([]);
    expect((await api.call("POST", "/opportunities", { token: b.token, body: { leadId, title: "stolen" } })).status).toBe(404);
    for (const [method, path, body] of [
      ["GET", `/opportunities/${opp}`, undefined], ["POST", `/opportunities/${opp}/stage`, { stage: "contacted" }], ["POST", `/opportunities/${opp}/notes`, { kind: "note", body: "x" }],
      ["POST", `/opportunities/${opp}/assign`, { userId: null }], ["POST", `/opportunities/${opp}/auto-assign`, undefined],
    ] as const) expect((await api.call(method, path, { token: b.token, ...(body ? { body } : {}) })).status).toBe(404);
    expect((await api.call("PUT", `/routing/pool/${s.userId}`, { token: b.token, body: { active: true, maxOpen: 1 } })).status).toBe(409); // not a member of B
    const ctx = { organizationId: b.orgId, userId: b.userId, role: "org_admin" };
    await asRuntime(ctx, async (c) => {
      for (const t of ["opportunities", "opportunity_stage_history", "opportunity_notes", "opportunity_assignments", "seller_pool"]) expect((await c.query(`SELECT 1 FROM ${t}`)).rowCount).toBe(0);
    });
    const denied = (sql: string, params: unknown[]) => asRuntime(ctx, async (c) => c.query(sql, params).then(() => "NO ERROR", (e: Error) => e.message));
    expect(await denied("INSERT INTO opportunities (organization_id, lead_id, prospect_id, title, created_by, updated_at) SELECT $1, id, prospect_id, 'x', $2, now() FROM leads WHERE id = $3", [b.orgId, b.userId, leadId])).toBe("NO ERROR"); // 0 rows: the lead is invisible
    expect(await denied("UPDATE opportunities SET organization_id = $1", [a.orgId])).toMatch(/permission denied/);
  });
});

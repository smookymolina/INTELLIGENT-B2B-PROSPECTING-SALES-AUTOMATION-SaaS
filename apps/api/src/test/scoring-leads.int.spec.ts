import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IntentAssessmentDto, LeadDto, MEMBERSHIP_ROLES, type MembershipRole } from "@prospecting/contracts";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** P5-01 + P8-01: attributes with human verification, versioned explainable scoring, rule/intent leads with human review. */
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
const RULES = [
  { id: "mx", label: "País objetivo", source: "field", name: "country", op: "eq", value: "MX", points: 30 },
  { id: "size", label: "Tamaño", source: "attribute", name: "employees", op: "gte", value: 50, points: 40 },
];
const prospect = async (t: string, over: Record<string, unknown> = {}) =>
  (await api.call("POST", "/prospects", { token: t, body: { name: `P ${randomUUID().slice(0, 6)}`, domain: `p-${randomUUID().slice(0, 8)}.example`, country: "MX", ...over } })).body as { id: string; domain: string };
const qualify = (t: string, id: string) => api.call("POST", `/prospects/${id}/status`, { token: t, body: { status: "qualified" } });
const addAttr = (t: string, pid: string, key: string, value: string, confidence = "medium") => api.call("POST", `/prospects/${pid}/attributes`, { token: t, body: { key, value, confidence } });
const decide = (t: string, pid: string, aid: string, decision: string) => api.call("POST", `/prospects/${pid}/attributes/${aid}/decision`, { token: t, body: { decision } });
async function approveModel(t: string, rules: unknown[] = RULES) {
  const saved = await api.call("PUT", "/scoring/model/draft", { token: t, body: { rules } });
  expect(saved.status).toBe(200);
  const res = await api.call("POST", "/scoring/model/approve", { token: t });
  expect(res.status).toBe(200);
  return res.body;
}
const setMin = (t: string, minScore: number) => api.call("PUT", "/leads/settings", { token: t, body: { minScore } });
const evaluate = (t: string) => api.call("POST", "/leads/evaluate", { token: t });
const score = (t: string, pid: string) => api.call("POST", `/prospects/${pid}/score`, { token: t });
const reply = (t: string, pid: string, text: string) => api.call("POST", `/prospects/${pid}/replies`, { token: t, body: { text } });
const leadsOf = async (t: string, state = "all") => (await api.call("GET", `/leads?state=${state}`, { token: t })).body.items as Array<{ id: string; state: string; origin: string; prospect: { id: string }; reviewNote: string | null; scoreTotal: number | null; intentClass: string | null }>;
const suppress = (t: string, value: string) => api.call("POST", "/suppressions", { token: t, body: { kind: "domain", value, reason: "test" } });

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("attributes", () => {
  it("never overwrite: a different value for the same key is a flagged conflict until a human verifies one", async () => {
    const a = await register("attr");
    const p = await prospect(a.token);
    const first = await addAttr(a.token, p.id, "employees", "120", "high");
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ key: "employees", value: "120", status: "unverified", source: "manual", conflict: false });
    expect((await addAttr(a.token, p.id, "employees", " 120 ")).status).toBe(409); // same value (case/space-insensitive)
    const second = await addAttr(a.token, p.id, "employees", "30", "low");
    expect(second.body.conflict).toBe(true);
    const list = (await api.call("GET", `/prospects/${p.id}/attributes`, { token: a.token })).body.items as Array<{ id: string; conflict: boolean; status: string }>;
    expect(list.map((x) => x.conflict)).toEqual([true, true]);

    const verified = await decide(a.token, p.id, first.body.id, "verify");
    expect(verified.body).toMatchObject({ status: "verified", conflict: false });
    const after = (await api.call("GET", `/prospects/${p.id}/attributes`, { token: a.token })).body.items as Array<{ id: string; status: string; conflict: boolean }>;
    expect(after.find((x) => x.id === second.body.id)).toMatchObject({ status: "rejected", conflict: false }); // kept, not deleted
    expect((await decide(a.token, p.id, first.body.id, "reject")).body.status).toBe("rejected");
    expect((await decide(a.token, p.id, randomUUID(), "verify")).status).toBe(404);
  });

  it("validates input and audits keys without values", async () => {
    const a = await register("attr-val");
    const p = await prospect(a.token);
    for (const body of [{ key: "Employees", value: "1", confidence: "low" }, { key: "x", value: "", confidence: "low" }, { key: "x", value: "1", confidence: "certain" }, { key: "x", value: "1", confidence: "low", status: "verified" }, { key: "x", value: "1", confidence: "low", organization_id: randomUUID() }]) {
      expect((await api.call("POST", `/prospects/${p.id}/attributes`, { token: a.token, body })).status).toBe(400);
    }
    await addAttr(a.token, p.id, "secret_note", "VALOR-CONFIDENCIAL-123");
    const events = JSON.stringify((await api.call("GET", "/audit-events?limit=100", { token: a.token })).body);
    expect(events).toContain("prospect.attribute_added");
    expect(events).not.toContain("VALOR-CONFIDENCIAL-123");
    expect((await addAttr(a.token, randomUUID(), "x", "1")).status).toBe(404);
  });
});

describe("scoring model and scores", () => {
  it("nothing scores until an administrator approves a model; sales_manager drafts but cannot approve", async () => {
    const a = await register("model");
    const sm = await member(a.orgId, "sales_manager");
    const p = await prospect(a.token);
    expect((await score(a.token, p.id)).status).toBe(409);
    expect((await api.call("POST", "/scoring/recompute", { token: a.token })).status).toBe(409);
    expect((await api.call("GET", "/scoring/model", { token: a.token })).body).toEqual({ approved: null, draft: null });
    expect((await api.call("PUT", "/scoring/model/draft", { token: sm.token, body: { rules: RULES } })).status).toBe(200);
    expect((await api.call("POST", "/scoring/model/approve", { token: sm.token })).status).toBe(403);
    expect((await api.call("PUT", "/scoring/model/draft", { token: a.token, body: { rules: [] } })).status).toBe(200); // replaces the open draft
    expect((await api.call("POST", "/scoring/model/approve", { token: a.token })).status).toBe(409); // an empty model cannot be approved
    expect((await api.call("PUT", "/scoring/model/draft", { token: a.token, body: { rules: RULES } })).body.draft.version).toBe(1);
    const approved = await api.call("POST", "/scoring/model/approve", { token: a.token });
    expect(approved.body.approved).toMatchObject({ version: 1, state: "approved" });
    expect(approved.body.draft).toBeNull();
  });

  it.each([
    ["unknown field", [{ id: "a", label: "x", source: "field", name: "revenue", op: "eq", value: "1", points: 1 }]],
    ["bad attribute key", [{ id: "a", label: "x", source: "attribute", name: "Bad Key", op: "exists", points: 1 }]],
    ["gte needs a number", [{ id: "a", label: "x", source: "attribute", name: "k", op: "gte", value: "10", points: 1 }]],
    ["in needs a list", [{ id: "a", label: "x", source: "field", name: "country", op: "in", value: "MX", points: 1 }]],
    ["exists takes no value", [{ id: "a", label: "x", source: "field", name: "city", op: "exists", value: "x", points: 1 }]],
    ["points out of range", [{ id: "a", label: "x", source: "field", name: "country", op: "eq", value: "MX", points: 101 }]],
    ["duplicate ids", [{ id: "a", label: "x", source: "field", name: "country", op: "eq", value: "MX", points: 1 }, { id: "a", label: "y", source: "field", name: "city", op: "exists", points: 1 }]],
    ["unknown key in a rule", [{ id: "a", label: "x", source: "field", name: "country", op: "eq", value: "MX", points: 1, code: "eval()" }]],
  ])("rejects an invalid rule set: %s", async (_n, rules) => {
    const a = await register("rules");
    expect((await api.call("PUT", "/scoring/model/draft", { token: a.token, body: { rules } })).status).toBe(400);
  });

  it("scores with verified evidence only, explains every rule, keeps history and flags stale scores", async () => {
    const a = await register("score");
    await approveModel(a.token);
    const p = await prospect(a.token, { country: "MX" });
    const attr = await addAttr(a.token, p.id, "employees", "120");
    expect((await score(a.token, p.id)).body.total).toBe(30); // unverified values are invisible to scoring
    await decide(a.token, p.id, attr.body.id, "verify");
    const result = await score(a.token, p.id);
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ total: 70, modelVersion: 1 });
    expect(result.body.breakdown).toEqual([
      { ruleId: "mx", label: "País objetivo", matched: true, points: 30, evidence: "field:country" },
      { ruleId: "size", label: "Tamaño", matched: true, points: 40, evidence: `attribute:${attr.body.id}` },
    ]);
    const latest = await api.call("GET", `/prospects/${p.id}/score`, { token: a.token });
    expect(latest.body).toMatchObject({ stale: false, result: { id: result.body.id, total: 70 } });

    await api.call("PUT", "/scoring/model/draft", { token: a.token, body: { rules: [RULES[0]] } });
    await api.call("POST", "/scoring/model/approve", { token: a.token });
    expect((await api.call("GET", `/prospects/${p.id}/score`, { token: a.token })).body.stale).toBe(true);
    const recomputed = await api.call("POST", "/scoring/recompute", { token: a.token });
    expect(recomputed.body).toMatchObject({ computed: 1, modelVersion: 2 });
    expect((await api.call("GET", `/prospects/${p.id}/score`, { token: a.token })).body).toMatchObject({ stale: false, result: { total: 30, modelVersion: 2 } });
    expect(Number((await owner.query("SELECT count(*) AS n FROM score_results WHERE prospect_id = $1", [p.id])).rows[0].n)).toBe(3); // append-only history: two manual scores + one recompute
  });

  it("approved models and scores are immutable at the database; scores need an approved version", async () => {
    const a = await register("immut");
    const model = await approveModel(a.token);
    const p = await prospect(a.token);
    const s = await score(a.token, p.id);
    const ctx = { organizationId: a.orgId, userId: a.userId, role: "org_admin" };
    const denied = (sql: string, params: unknown[] = []) => asRuntime(ctx, async (c) => c.query(sql, params).then(() => "NO ERROR", (e: Error) => e.message));
    expect(await denied("UPDATE scoring_model_versions SET rules = '[]'::jsonb WHERE id = $1", [model.approved.id])).toMatch(/immutable/);
    await expect(owner.query("UPDATE scoring_model_versions SET rules = '[]'::jsonb WHERE id = $1", [model.approved.id])).rejects.toThrow(/immutable/);
    expect(await denied("UPDATE score_results SET total = 99 WHERE id = $1", [s.body.id])).toMatch(/permission denied/);
    expect(await denied("DELETE FROM score_results")).toMatch(/permission denied/);
    await api.call("PUT", "/scoring/model/draft", { token: a.token, body: { rules: RULES } });
    const draftId = (await api.call("GET", "/scoring/model", { token: a.token })).body.draft.id;
    expect(await denied("INSERT INTO score_results (organization_id, prospect_id, model_version_id, total, breakdown, computed_by) VALUES ($1,$2,$3,1,'[]'::jsonb,$4)", [a.orgId, p.id, draftId, a.userId])).toMatch(/approved model/);
  });

  it("recompute skips do-not-contact prospects", async () => {
    const a = await register("recompute");
    await approveModel(a.token);
    const ok = await prospect(a.token);
    const blocked = await prospect(a.token);
    await suppress(a.token, blocked.domain);
    const res = await api.call("POST", "/scoring/recompute", { token: a.token });
    expect(res.body).toMatchObject({ computed: 1, skippedSuppressed: 1 });
    expect((await api.call("GET", `/prospects/${blocked.id}/score`, { token: a.token })).body.result).toBeNull();
    expect((await api.call("GET", `/prospects/${ok.id}/score`, { token: a.token })).body.result).not.toBeNull();
  });
});

describe("rule-created leads", () => {
  it("require an explicit threshold and approved model, then create pending leads idempotently", async () => {
    const a = await register("lead");
    const sm = await member(a.orgId, "sales_manager");
    expect((await api.call("GET", "/leads/settings", { token: a.token })).body).toEqual({ minScore: null });
    expect((await evaluate(a.token)).status).toBe(409); // no threshold
    expect((await setMin(sm.token, 50)).status).toBe(403); // only the administrator sets it
    expect((await setMin(a.token, 50)).body).toEqual({ minScore: 50 });
    expect((await evaluate(a.token)).status).toBe(409); // no approved model
    await approveModel(a.token);

    const hot = await prospect(a.token, { country: "MX" });
    const cold = await prospect(a.token, { country: "CO" });
    const unscored = await prospect(a.token, { country: "MX" });
    const candidate = await prospect(a.token, { country: "MX" });
    const blocked = await prospect(a.token, { country: "MX" });
    const attr = await addAttr(a.token, hot.id, "employees", "200");
    await decide(a.token, hot.id, attr.body.id, "verify");
    for (const p of [hot, cold, unscored, blocked]) await qualify(a.token, p.id);
    for (const p of [hot, cold, candidate, blocked]) await score(a.token, p.id);
    await suppress(a.token, blocked.domain);

    const first = await evaluate(a.token);
    expect(first.body).toEqual({ created: 1, alreadyOpen: 0, belowThreshold: 1, noScore: 1, suppressed: 0, previouslyRejected: 0 });
    // `blocked` was disqualified by the suppression, `candidate` was never qualified: neither is even considered
    const pending = await leadsOf(a.token, "pending_review");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ origin: "rule", scoreTotal: 70, prospect: { id: hot.id } });
    expect(LeadDto.safeParse((await api.call("GET", `/leads/${pending[0]?.id}`, { token: a.token })).body).success).toBe(true);

    expect((await evaluate(a.token)).body).toMatchObject({ created: 0, alreadyOpen: 1 }); // idempotent
    expect((await leadsOf(a.token)).length).toBe(1);
  });

  it("human review: accept or reject once; a rejected lead is not re-created from the same evidence but is from new evidence", async () => {
    const a = await register("review");
    await approveModel(a.token);
    await setMin(a.token, 30);
    const p = await prospect(a.token, { country: "MX" });
    await qualify(a.token, p.id);
    await score(a.token, p.id);
    await evaluate(a.token);
    const lead = (await leadsOf(a.token, "pending_review"))[0] as { id: string };

    const rejected = await api.call("POST", `/leads/${lead.id}/decision`, { token: a.token, body: { decision: "reject", note: "sin presupuesto" } });
    expect(rejected.body).toMatchObject({ state: "rejected", reviewNote: "sin presupuesto" });
    expect((await api.call("POST", `/leads/${lead.id}/decision`, { token: a.token, body: { decision: "accept" } })).status).toBe(409);
    expect((await evaluate(a.token)).body).toMatchObject({ created: 0, previouslyRejected: 1 });
    await score(a.token, p.id); // new evidence
    expect((await evaluate(a.token)).body.created).toBe(1);
    const again = (await leadsOf(a.token, "pending_review"))[0] as { id: string };
    expect((await api.call("POST", `/leads/${again.id}/decision`, { token: a.token, body: { decision: "accept" } })).body.state).toBe("accepted");
    expect((await evaluate(a.token)).body).toMatchObject({ created: 0, alreadyOpen: 1 });
    const events = (await api.call("GET", "/audit-events?limit=100", { token: a.token })).body.map((e: { action: string }) => e.action);
    expect(events).toEqual(expect.arrayContaining(["lead.created", "lead.rejected", "lead.accepted", "leads.settings_changed"]));
    expect((await api.call("GET", "/leads?state=accepted", { token: a.token })).body.items).toHaveLength(1);
    for (const q of ["state=maybe", "limit=0", "cursor=zzz"]) expect((await api.call("GET", `/leads?${q}`, { token: a.token })).status).toBe(400);
  });

  it("a new do-not-contact entry closes pending leads even when added by a role that cannot review leads", async () => {
    const a = await register("closeleads");
    const cm = await member(a.orgId, "campaign_manager");
    await approveModel(a.token);
    await setMin(a.token, 30);
    const p = await prospect(a.token, { country: "MX" });
    await qualify(a.token, p.id);
    await score(a.token, p.id);
    await evaluate(a.token);
    expect((await suppress(cm.token, p.domain)).status).toBe(201);
    const closed = await leadsOf(a.token, "rejected");
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ reviewNote: "suppressed", prospect: { id: p.id } });
    expect((await evaluate(a.token)).body).toMatchObject({ created: 0 });
  });

  it("the database refuses leads for unqualified or suppressed prospects and edits to reviewed leads", async () => {
    const a = await register("leaddb");
    await approveModel(a.token);
    await setMin(a.token, 0);
    const cand = await prospect(a.token);
    const sc = (await score(a.token, cand.id)).body.id;
    const ctx = { organizationId: a.orgId, userId: a.userId, role: "org_admin" };
    const denied = (sql: string, params: unknown[] = []) => asRuntime(ctx, async (c) => c.query(sql, params).then(() => "NO ERROR", (e: Error) => e.message));
    const insert = "INSERT INTO leads (organization_id, prospect_id, origin, open_key, score_result_id, min_score, created_by) VALUES ($1,$2,'rule',$5,$3,0,$4)";
    expect(await denied(insert, [a.orgId, cand.id, sc, a.userId, cand.id])).toMatch(/qualified prospect/);
    await qualify(a.token, cand.id);
    await suppress(a.token, cand.domain);
    expect(await denied(insert, [a.orgId, cand.id, sc, a.userId, cand.id])).toMatch(/suppressed prospect/);
    expect(await denied("DELETE FROM leads")).toMatch(/permission denied/);

    const ok = await prospect(a.token);
    await qualify(a.token, ok.id);
    const sc2 = (await score(a.token, ok.id)).body.id;
    await evaluate(a.token);
    const lead = (await leadsOf(a.token, "pending_review")).find((l) => l.prospect.id === ok.id) as { id: string };
    await api.call("POST", `/leads/${lead.id}/decision`, { token: a.token, body: { decision: "accept" } });
    expect(await denied("UPDATE leads SET state = 'rejected', open_key = NULL, review_note = 'x', reviewed_at = now() WHERE id = $1", [lead.id])).toMatch(/cannot change/);
    expect(sc2).toBeTruthy();
  });
});

describe("reply classification", () => {
  it("positive intent opens ONE pending lead for human review, with the classification as evidence", async () => {
    const a = await register("intent");
    const p = await prospect(a.token);
    const res = await reply(a.token, p.id, "Hola, ¿me pueden enviar una cotización del producto?");
    expect(res.status).toBe(201);
    expect(IntentAssessmentDto.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({ class: "quote", ambiguous: false, classifierVersion: "rules-v1", matched: [{ class: "quote", phrase: "cotizacion" }], effects: { suppressionCreated: false } });
    expect(res.body.effects.leadId).toBeTruthy();
    const leads = await leadsOf(a.token, "pending_review");
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ origin: "intent", intentClass: "quote", scoreTotal: null });
    const second = await reply(a.token, p.id, "Queremos comprar 10 unidades");
    expect(second.body.class).toBe("purchase");
    expect(second.body.effects.leadId).toBeNull(); // one open lead per prospect
    expect(await leadsOf(a.token, "pending_review")).toHaveLength(1);
    const history = (await api.call("GET", `/prospects/${p.id}/replies`, { token: a.token })).body.items;
    expect(history).toHaveLength(2);
    expect(history.find((h: { id: string }) => h.id === res.body.id).effects.leadId).toBe(leads[0]?.id);
  });

  it("an unsubscribe request wins: it suppresses the prospect, disqualifies it and closes its lead", async () => {
    const a = await register("unsub");
    const p = await prospect(a.token);
    await qualify(a.token, p.id);
    await reply(a.token, p.id, "Me interesa una cotización");
    expect(await leadsOf(a.token, "pending_review")).toHaveLength(1);
    const res = await reply(a.token, p.id, "Por favor, queremos comprar pero no me contacten más. Darme de baja.");
    expect(res.body).toMatchObject({ class: "unsubscribe", effects: { suppressionCreated: true, leadId: null } });
    const after = (await api.call("GET", `/prospects/${p.id}`, { token: a.token })).body;
    expect(after).toMatchObject({ suppressed: true, status: "disqualified", statusReason: "suppressed" });
    expect((await leadsOf(a.token, "rejected"))[0]).toMatchObject({ reviewNote: "suppressed" });
    expect((await api.call("GET", "/suppressions", { token: a.token })).body.items[0]).toMatchObject({ kind: "domain", value: p.domain, reason: "unsubscribe request in a reply" });
    const again = await reply(a.token, p.id, "unsubscribe");
    expect(again.body.effects.suppressionCreated).toBe(false); // already on the list
    expect((await reply(a.token, p.id, "Queremos comprar")).body.effects.leadId).toBeNull(); // suppressed prospects never become leads
  });

  it("ambiguous or unmatched replies go to human review without side effects; excerpts are bounded", async () => {
    const a = await register("amb");
    const p = await prospect(a.token);
    const tie = await reply(a.token, p.id, "Necesito una cotización y más información");
    expect(tie.body).toMatchObject({ class: "review", ambiguous: true, effects: { suppressionCreated: false, leadId: null } });
    expect((await reply(a.token, p.id, "Gracias, saludos")).body).toMatchObject({ class: "review", ambiguous: false, matched: [] });
    expect((await reply(a.token, p.id, "Aún no queremos comprar")).body).toMatchObject({ class: "review", ambiguous: true });
    expect(await leadsOf(a.token)).toEqual([]);
    const long = await reply(a.token, p.id, `Gracias ${"x".repeat(3000)}`);
    expect(long.body.excerpt.length).toBe(500);
    const row = (await owner.query("SELECT text_hash, length(excerpt) AS n FROM intent_assessments WHERE id = $1", [long.body.id])).rows[0];
    expect(row.text_hash).toMatch(/^[0-9a-f]{64}$/);
    for (const body of [{}, { text: "" }, { text: "x".repeat(4001) }, { text: "hola", prospectId: randomUUID() }]) expect((await api.call("POST", `/prospects/${p.id}/replies`, { token: a.token, body })).status).toBe(400);
    expect((await reply(a.token, randomUUID(), "hola")).status).toBe(404);
  });
});

describe("RBAC", () => {
  const expected: Record<MembershipRole, { leadsRead: number; review: number; scoringManage: number; approve: number; prospectsManage: number }> = {
    org_admin: { leadsRead: 200, review: 200, scoringManage: 200, approve: 200, prospectsManage: 201 },
    sales_manager: { leadsRead: 200, review: 200, scoringManage: 200, approve: 403, prospectsManage: 201 },
    campaign_manager: { leadsRead: 200, review: 403, scoringManage: 403, approve: 403, prospectsManage: 201 },
    seller: { leadsRead: 403, review: 403, scoringManage: 403, approve: 403, prospectsManage: 403 },
    analyst: { leadsRead: 200, review: 403, scoringManage: 403, approve: 403, prospectsManage: 403 },
    viewer: { leadsRead: 200, review: 403, scoringManage: 403, approve: 403, prospectsManage: 403 },
  };
  it("covers every role", () => expect(Object.keys(expected).sort()).toEqual([...MEMBERSHIP_ROLES].sort()));

  it.each(MEMBERSHIP_ROLES)("%s", async (role) => {
    const a = await register(`rbac-${role}`);
    await approveModel(a.token);
    await setMin(a.token, 0);
    const p = await prospect(a.token);
    await qualify(a.token, p.id);
    const token = role === "org_admin" ? a.token : (await member(a.orgId, role)).token;
    const e = expected[role];
    expect((await api.call("GET", "/leads", { token })).status).toBe(e.leadsRead);
    expect((await api.call("GET", "/leads/settings", { token })).status).toBe(e.leadsRead);
    expect((await api.call("GET", "/scoring/model", { token })).status).toBe(200);
    expect((await api.call("GET", `/prospects/${p.id}/attributes`, { token })).status).toBe(200);
    expect((await api.call("GET", `/prospects/${p.id}/replies`, { token })).status).toBe(200);
    expect((await evaluate(token)).status).toBe(e.review);
    expect((await api.call("PUT", "/scoring/model/draft", { token, body: { rules: RULES } })).status).toBe(e.scoringManage);
    expect((await api.call("POST", "/scoring/model/approve", { token })).status).toBe(e.scoringManage === 200 ? (role === "org_admin" ? 200 : 403) : 403);
    expect((await setMin(token, 5)).status).toBe(e.approve);
    expect((await addAttr(token, p.id, "employees", `${role}-1`)).status).toBe(e.prospectsManage);
    expect((await score(token, p.id)).status).toBe(e.prospectsManage === 201 ? 201 : 403);
    expect((await reply(token, p.id, "hola")).status).toBe(e.prospectsManage);
    expect((await api.call("POST", "/scoring/recompute", { token })).status).toBe(e.prospectsManage === 201 ? 200 : 403);
  });
});

describe("tenant isolation", () => {
  it("tenant B cannot see or touch A's attributes, scores, model, replies or leads", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    await approveModel(a.token);
    await setMin(a.token, 0);
    const p = await prospect(a.token);
    await qualify(a.token, p.id);
    const attr = await addAttr(a.token, p.id, "employees", "100");
    const sc = await score(a.token, p.id);
    await reply(a.token, p.id, "Queremos comprar");
    await evaluate(a.token);
    const lead = (await leadsOf(a.token, "pending_review"))[0] as { id: string };

    expect((await api.call("GET", "/scoring/model", { token: b.token })).body).toEqual({ approved: null, draft: null });
    expect((await api.call("GET", "/leads", { token: b.token })).body.items).toEqual([]);
    expect((await api.call("GET", "/leads/settings", { token: b.token })).body.minScore).toBeNull();
    for (const [method, path, body] of [
      ["GET", `/prospects/${p.id}/attributes`, undefined], ["POST", `/prospects/${p.id}/attributes/${attr.body.id}/decision`, { decision: "reject" }],
      ["GET", `/prospects/${p.id}/score`, undefined], ["POST", `/prospects/${p.id}/replies`, { text: "hola" }], ["GET", `/prospects/${p.id}/replies`, undefined],
      ["GET", `/leads/${lead.id}`, undefined], ["POST", `/leads/${lead.id}/decision`, { decision: "accept" }],
    ] as const) expect((await api.call(method, path, { token: b.token, ...(body ? { body } : {}) })).status).toBe(404);

    const ctx = { organizationId: b.orgId, userId: b.userId, role: "org_admin" };
    await asRuntime(ctx, async (c) => {
      for (const t of ["prospect_attributes", "score_results", "leads", "intent_assessments", "scoring_model_versions"]) expect((await c.query(`SELECT 1 FROM ${t}`)).rowCount).toBe(0);
      expect((await c.query("UPDATE leads SET review_note = 'x'")).rowCount).toBe(0);
    });
    const denied = (sql: string, params: unknown[]) => asRuntime(ctx, async (cl) => cl.query(sql, params).then(() => "NO ERROR", (e: Error) => e.message));
    expect(await denied("INSERT INTO intent_assessments (organization_id, prospect_id, excerpt, text_hash, classifier_version, class, matched, ambiguous, created_by) VALUES ($1,$2,'x',$3,'v','review','[]'::jsonb,false,$4)", [a.orgId, p.id, "0".repeat(64), b.userId])).toMatch(/row-level security/);
    expect(await denied("INSERT INTO score_results (organization_id, prospect_id, model_version_id, total, breakdown, computed_by) VALUES ($1,$2,$3,1,'[]'::jsonb,$4)", [b.orgId, p.id, sc.body.id, b.userId])).toMatch(/foreign key|approved model/);
  });
});

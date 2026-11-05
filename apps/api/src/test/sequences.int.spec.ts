import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MembershipRole, RunDueResultDto } from "@prospecting/contracts";
import { EmailChannels } from "../campaigns/channels.js";
import { insideWindow, nextAllowed } from "../sequences/schedule.js";
import { HttpException } from "@nestjs/common";
import { SequencesService } from "../sequences/sequences.service.js";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** F7 sequences: chained steps, per-campaign time window/zone, sandbox only. Nothing sends unless approved + launched + eligible + inside the window. */
let api: Api;
type Account = { token: string; orgId: string; userId: string };
const accounts = new Map<string, Account>();

async function register(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label}` } });
  const me = await api.call("GET", "/me", { token: res.body.token });
  const acc = { token: res.body.token as string, orgId: res.body.organization.id as string, userId: me.body.user.id as string };
  accounts.set(acc.token, acc);
  return acc;
}
async function member(orgId: string, role: MembershipRole) {
  const m = await seedMember(orgId, role);
  return (await api.call("POST", "/auth/login", { body: { email: m.email, password: PASSWORD } })).body.token as string;
}
const outbox = () => api.app.get(EmailChannels).sandbox.outbox;
const clock = (at: string) => {
  api.app.get(SequencesService).now = () => new Date(at);
};
const iso = (offsetMs = -60_000) => new Date(Date.now() + offsetMs).toISOString();

async function contact(t: string, opts: { consent?: boolean } = {}) {
  const domain = `seq-${randomUUID().slice(0, 8)}.example`;
  const p = (await api.call("POST", "/prospects", { token: t, body: { name: `Co ${randomUUID().slice(0, 5)}`, domain } })).body as { id: string };
  const c = (await api.call("POST", `/prospects/${p.id}/contacts`, { token: t, body: { address: `compras@${domain}`, displayName: "Compras", source: "Formulario web, 2026-09-01" } })).body as { id: string };
  if (opts.consent !== false) {
    const r = await api.call("POST", `/contacts/${c.id}/consent`, { token: t, body: { event: "granted", evidence: "Casilla marcada en el formulario web, 2026-09-01", occurredAt: iso() } });
    expect(r.status).toBe(201);
  }
  return { contactId: c.id, domain };
}
const withdraw = (t: string, cid: string) => api.call("POST", `/contacts/${cid}/consent`, { token: t, body: { event: "withdrawn", evidence: "Baja por telefono", occurredAt: iso(-1000) } });

// Mexico City has no DST since 2022: UTC-6 all year. Window Mon-Fri 09:00-18:00 local = 15:00-24:00 UTC.
const SEQ = {
  timezone: "America/Mexico_City",
  windowStart: "09:00",
  windowEnd: "18:00",
  weekdays: [1, 2, 3, 4, 5],
  steps: [
    { delayHours: 0, subject: "Hola {{company}}", body: "Primer contacto con {{company}}. Baja: {{unsubscribe_url}}" },
    { delayHours: 48, subject: "Seguimiento {{company}}", body: "Segundo mensaje. Baja: {{unsubscribe_url}}" },
    { delayHours: 24, subject: "Ultimo aviso", body: "Tercer mensaje. Baja: {{unsubscribe_url}}" },
  ],
};
const MON_10 = "2026-11-09T16:00:00.000Z"; // Monday 10:00 local
const seqUrl = (id: string, tail = "") => `/campaigns/${id}/sequence${tail}`;

async function campaign(t: string, over: Record<string, unknown> = {}, seq: Record<string, unknown> | null = SEQ): Promise<string> {
  const c = (await api.call("POST", "/campaigns", { token: t, body: { name: "Secuencia", subject: "base", body: "base {{unsubscribe_url}}", ...over } })).body as { id: string };
  if (seq) expect((await api.call("PUT", seqUrl(c.id), { token: t, body: seq })).status).toBe(200);
  return c.id;
}
async function running(t: string, over: Record<string, unknown> = {}) {
  const id = await campaign(t, over);
  expect((await api.call("POST", `/campaigns/${id}/approve`, { token: t })).status).toBe(200);
  expect((await api.call("POST", `/campaigns/${id}/launch`, { token: t })).status).toBe(200);
  return id;
}
const enroll = (t: string, id: string) => api.call("POST", seqUrl(id, "/enroll"), { token: t });
// There is NO HTTP endpoint that sends: only the worker calls SequencesService.runDue. Tests call it the way the worker does.
const runDue = async (t: string, id: string, body?: { limit?: number }): Promise<{ status: number; body: RunDueResultDto }> => {
  const a = accounts.get(t);
  if (!a) throw new Error("unknown token");
  try {
    return { status: 200, body: await api.app.get(SequencesService).runDue({ sessionId: "test-worker", userId: a.userId, organizationId: a.orgId, role: "org_admin", requestId: "test-worker" }, id, body?.limit ?? 50) };
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), body: null as unknown as RunDueResultDto };
    throw e;
  }
};
const enrollments = async (t: string, id: string) => (await api.call("GET", seqUrl(id, "/enrollments"), { token: t })).body.items as Array<{ state: string; stopReason: string | null; nextStep: number; nextDueAt: string | null; deliveries: Array<{ stepNo: number }> }>;

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  api.app.get(SequencesService).now = () => new Date();
  await api.close();
});
beforeEach(() => {
  outbox().length = 0;
  clock(MON_10);
});

describe("window maths", () => {
  const w = { timezone: "America/Mexico_City", startMin: 540, endMin: 1080, weekdays: [1, 2, 3, 4, 5] };
  it("keeps instants inside the window and moves the rest to the next opening", () => {
    expect(insideWindow(new Date(MON_10), w)).toBe(true);
    expect(nextAllowed(new Date(MON_10), w).toISOString()).toBe(MON_10);
    expect(nextAllowed(new Date("2026-11-09T13:00:00Z"), w).toISOString()).toBe("2026-11-09T15:00:00.000Z"); // 07:00 -> same day 09:00
    expect(nextAllowed(new Date("2026-11-10T00:30:00Z"), w).toISOString()).toBe("2026-11-10T15:00:00.000Z"); // Mon 18:30 -> Tue 09:00
    expect(nextAllowed(new Date("2026-11-14T20:00:00Z"), w).toISOString()).toBe("2026-11-16T15:00:00.000Z"); // Saturday -> Monday
    expect(nextAllowed(new Date("2026-11-13T23:59:00Z"), w).toISOString()).toBe("2026-11-13T23:59:00.000Z"); // Fri 17:59 local: last minute
  });
  it("handles a time zone with daylight saving", () => {
    const madrid = { timezone: "Europe/Madrid", startMin: 540, endMin: 1080, weekdays: [1, 2, 3, 4, 5] };
    expect(nextAllowed(new Date("2026-10-23T03:00:00Z"), madrid).toISOString()).toBe("2026-10-23T07:00:00.000Z"); // CEST (+2)
    expect(nextAllowed(new Date("2026-11-03T03:00:00Z"), madrid).toISOString()).toBe("2026-11-03T08:00:00.000Z"); // CET (+1)
  });
});

describe("sequence configuration", () => {
  it("validates the zone, the window and the first step; saves and replaces while the campaign is a draft", async () => {
    const a = await register("seq-cfg");
    const id = await campaign(a.token, {}, null);
    expect((await api.call("GET", seqUrl(id), { token: a.token })).body).toMatchObject({ configured: false, steps: [] });
    for (const bad of [
      { ...SEQ, timezone: "Mars/Olympus" },
      { ...SEQ, windowEnd: "09:00" },
      { ...SEQ, weekdays: [] },
      { ...SEQ, weekdays: [1, 1] },
      { ...SEQ, steps: [] },
      { ...SEQ, steps: [{ ...SEQ.steps[0], delayHours: 5 }] },
      { ...SEQ, steps: SEQ.steps.map((s) => ({ ...s, extra: 1 })) },
    ]) expect((await api.call("PUT", seqUrl(id), { token: a.token, body: bad })).status).toBe(400);
    const saved = await api.call("PUT", seqUrl(id), { token: a.token, body: SEQ });
    expect(saved.body).toMatchObject({ configured: true, timezone: "America/Mexico_City", windowStart: "09:00", windowEnd: "18:00", weekdays: [1, 2, 3, 4, 5] });
    expect(saved.body.steps.map((s: { stepNo: number }) => s.stepNo)).toEqual([1, 2, 3]);
    const replaced = await api.call("PUT", seqUrl(id), { token: a.token, body: { ...SEQ, steps: [SEQ.steps[0]] } });
    expect(replaced.body.steps).toHaveLength(1);
    // approval covers the exact content: no edits afterwards, and no enrolment before launch
    expect((await api.call("POST", `/campaigns/${id}/approve`, { token: a.token })).status).toBe(200);
    expect((await api.call("PUT", seqUrl(id), { token: a.token, body: SEQ })).status).toBe(409);
    expect((await enroll(a.token, id)).status).toBe(409);
    expect((await runDue(a.token, id)).status).toBe(409);
    expect((await api.call("PUT", seqUrl(randomUUID()), { token: a.token, body: SEQ })).status).toBe(404);
  });

  it("refuses to enrol in a running campaign that has no sequence", async () => {
    const a = await register("seq-none");
    const id = await campaign(a.token, {}, null);
    await api.call("POST", `/campaigns/${id}/approve`, { token: a.token });
    await api.call("POST", `/campaigns/${id}/launch`, { token: a.token });
    expect((await enroll(a.token, id)).status).toBe(409);
  });
});

describe("happy path", () => {
  it("sends step 1 now, step 2 after 48 h and step 3 after 24 h more, then completes; nothing runs twice", async () => {
    const a = await register("seq-happy");
    const k = await contact(a.token);
    const id = await running(a.token);
    expect((await enroll(a.token, id)).body).toMatchObject({ enrolled: 1, alreadyEnrolled: 0, firstDueAt: MON_10 });
    expect((await enroll(a.token, id)).body).toMatchObject({ enrolled: 0, alreadyEnrolled: 1 }); // idempotent

    expect((await runDue(a.token, id)).body).toMatchObject({ processed: 1, sent: 1, completed: 0, deferred: 0, nextDueAt: "2026-11-11T16:00:00.000Z" });
    expect(outbox()).toHaveLength(1);
    expect(outbox()[0]).toMatchObject({ to: `compras@${k.domain}` });
    expect(outbox()[0]?.subject).toMatch(/^Hola Co /);
    expect(outbox()[0]?.body).toContain("/unsubscribe?o=");
    expect((await runDue(a.token, id)).body).toMatchObject({ processed: 0, sent: 0 }); // not due yet: the worker can call as often as it likes

    clock("2026-11-11T16:00:00.000Z"); // Wed 10:00 local
    expect((await runDue(a.token, id)).body).toMatchObject({ processed: 1, sent: 1, nextDueAt: "2026-11-12T16:00:00.000Z" });
    clock("2026-11-12T16:00:00.000Z");
    expect((await runDue(a.token, id)).body).toMatchObject({ processed: 1, sent: 1, completed: 1, nextDueAt: null });
    expect(outbox().map((m) => m.subject.split(" ")[0])).toEqual(["Hola", "Seguimiento", "Ultimo"]);

    const [e] = await enrollments(a.token, id);
    expect(e).toMatchObject({ state: "completed", stopReason: null, nextDueAt: null });
    expect(e?.deliveries.map((d) => d.stepNo)).toEqual([1, 2, 3]);
    clock("2026-11-30T16:00:00.000Z");
    expect((await runDue(a.token, id)).body).toMatchObject({ processed: 0 });
    expect(outbox()).toHaveLength(3);
    const audit = await owner.query("SELECT action FROM audit_events WHERE organization_id = $1 AND action LIKE 'sequence.%'", [a.orgId]);
    expect(new Set(audit.rows.map((r) => r.action))).toEqual(new Set(["sequence.saved", "sequence.enrolled", "sequence.run"]));
  });
});

describe("time window", () => {
  it("first step waits for the next opening when enrolling on a Saturday", async () => {
    const a = await register("seq-sat");
    await contact(a.token);
    const id = await running(a.token);
    clock("2026-11-14T20:00:00.000Z"); // Saturday 14:00 local
    expect((await enroll(a.token, id)).body).toMatchObject({ enrolled: 1, firstDueAt: "2026-11-16T15:00:00.000Z" });
    expect((await runDue(a.token, id)).body).toMatchObject({ processed: 0 });
    expect(outbox()).toHaveLength(0);
    clock("2026-11-16T15:00:00.000Z");
    expect((await runDue(a.token, id)).body).toMatchObject({ sent: 1 });
  });

  it("a late worker defers instead of sending outside the window; a delay that lands on the weekend moves to Monday", async () => {
    const a = await register("seq-late");
    await contact(a.token);
    const id = await running(a.token);
    await enroll(a.token, id);
    clock("2026-11-12T16:00:00.000Z"); // Thursday 10:00 local
    expect((await runDue(a.token, id)).body).toMatchObject({ sent: 1, nextDueAt: "2026-11-16T15:00:00.000Z" }); // +48 h = Saturday -> Monday 09:00 local
    clock("2026-11-17T02:00:00.000Z"); // Monday 20:00 local: due, but the window is closed
    expect((await runDue(a.token, id)).body).toMatchObject({ processed: 1, sent: 0, deferred: 1, nextDueAt: "2026-11-17T15:00:00.000Z" });
    expect(outbox()).toHaveLength(1);
    clock("2026-11-17T15:00:00.000Z");
    expect((await runDue(a.token, id)).body).toMatchObject({ sent: 1 });
    expect(outbox()).toHaveLength(2);
  });
});

describe("eligibility cuts the sequence", () => {
  it("a withdrawn consent or a suppression after step 1 stops the enrolment without sending", async () => {
    const a = await register("seq-stop");
    const gone = await contact(a.token);
    const suppressed = await contact(a.token);
    const stays = await contact(a.token);
    const id = await running(a.token);
    expect((await enroll(a.token, id)).body.enrolled).toBe(3);
    expect((await runDue(a.token, id)).body).toMatchObject({ sent: 3 });
    expect((await withdraw(a.token, gone.contactId)).status).toBe(201);
    expect((await api.call("POST", "/suppressions", { token: a.token, body: { kind: "domain", value: suppressed.domain, reason: "baja posterior" } })).status).toBe(201);
    clock("2026-11-11T16:00:00.000Z");
    const res = await runDue(a.token, id);
    expect(res.body).toMatchObject({ processed: 3, sent: 1, stopped: { opted_out: 1, suppressed: 1 } });
    expect(outbox()).toHaveLength(4); // 3 first steps + 1 second step
    const byState = (await enrollments(a.token, id)).map((e) => `${e.state}:${e.stopReason ?? ""}:${e.nextStep}`).sort();
    expect(byState).toEqual(["active::3", "stopped:opted_out:2", "stopped:suppressed:2"].sort());
    expect(stays.contactId).toBeTruthy();
  });

  it("enrolment excludes contacts without consent or suppressed, and counts them", async () => {
    const a = await register("seq-enrol-excl");
    await contact(a.token);
    await contact(a.token, { consent: false });
    const s = await contact(a.token);
    await api.call("POST", "/suppressions", { token: a.token, body: { kind: "domain", value: s.domain, reason: "no contactar" } });
    const id = await running(a.token);
    expect((await enroll(a.token, id)).body).toMatchObject({ enrolled: 1, excluded: { no_consent: 1, suppressed: 1, recently_contacted: 0 } });
  });

  it("frequency cap: a recent send from another campaign blocks enrolment and stops a running sequence", async () => {
    process.env.EMAIL_PROVIDER = "sandbox";
    const a = await register("seq-cap");
    const later = await contact(a.token);
    const id = await running(a.token); // min_days_between defaults to 7
    expect((await enroll(a.token, id)).body.enrolled).toBe(1);
    expect((await runDue(a.token, id)).body).toMatchObject({ sent: 1 });

    // ANOTHER campaign now emails both the enrolled contact and a new one
    const capped = await contact(a.token);
    const other = (await api.call("POST", "/campaigns", { token: a.token, body: { name: "Otra", subject: "x", body: "x {{unsubscribe_url}}", minDaysBetween: 0 } })).body.id as string;
    await api.call("POST", `/campaigns/${other}/approve`, { token: a.token });
    await api.call("POST", `/campaigns/${other}/launch`, { token: a.token });
    expect((await api.call("POST", `/campaigns/${other}/dispatch`, { token: a.token })).body.sent).toBe(2);
    delete process.env.EMAIL_PROVIDER;
    outbox().length = 0;

    expect((await enroll(a.token, id)).body).toMatchObject({ enrolled: 0, alreadyEnrolled: 1, excluded: { recently_contacted: 1 } });
    clock("2026-11-11T16:00:00.000Z");
    expect((await runDue(a.token, id)).body).toMatchObject({ processed: 1, sent: 0, stopped: { recently_contacted: 1 } });
    expect(outbox()).toHaveLength(0);
    expect((await enrollments(a.token, id))[0]).toMatchObject({ state: "stopped", stopReason: "recently_contacted" });
    expect([later.contactId, capped.contactId]).toHaveLength(2);
  });

  it("frequency cap: a step sent by one sequence blocks enrolment of the same contact in another campaign", async () => {
    process.env.EMAIL_PROVIDER = "sandbox";
    const a = await register("seq-cap-seq");
    await contact(a.token);
    const first = await running(a.token);
    expect((await enroll(a.token, first)).body.enrolled).toBe(1);
    expect((await runDue(a.token, first)).body).toMatchObject({ sent: 1 });
    const second = await running(a.token); // min_days_between defaults to 7
    expect((await enroll(a.token, second)).body).toMatchObject({ enrolled: 0, excluded: { recently_contacted: 1 } });
    delete process.env.EMAIL_PROVIDER;
  });

  it("pausing holds the sequence, cancelling closes it", async () => {
    const a = await register("seq-pause");
    await contact(a.token);
    const id = await running(a.token);
    await enroll(a.token, id);
    await runDue(a.token, id);
    clock("2026-11-11T16:00:00.000Z");
    await api.call("POST", `/campaigns/${id}/pause`, { token: a.token });
    expect((await runDue(a.token, id)).body).toMatchObject({ processed: 0, sent: 0 });
    expect(outbox()).toHaveLength(1);
    await api.call("POST", `/campaigns/${id}/resume`, { token: a.token });
    await api.call("POST", `/campaigns/${id}/cancel`, { token: a.token });
    expect((await runDue(a.token, id)).body).toMatchObject({ processed: 1, sent: 0, stopped: { campaign_closed: 1 } });
    expect(outbox()).toHaveLength(1);
  });
});

describe("roles", () => {
  it("viewer is denied everywhere; a campaign manager can configure and run; the seller cannot manage", async () => {
    const a = await register("seq-rbac");
    const viewer = await member(a.orgId, "viewer");
    const manager = await member(a.orgId, "campaign_manager");
    const id = await campaign(a.token);
    for (const [m, p, body] of [["GET", seqUrl(id)], ["PUT", seqUrl(id), SEQ], ["POST", seqUrl(id, "/enroll")], ["GET", seqUrl(id, "/enrollments")]] as Array<[string, string, unknown?]>) {
      expect((await api.call(m, p, { token: viewer, ...(body ? { body } : {}) })).status, `${m} ${p}`).toBe(403);
    }
    expect((await api.call("POST", seqUrl(id, "/run-due"), { token: manager })).status).toBe(404); // sending over HTTP does not exist
    expect((await api.call("PUT", seqUrl(id), { token: manager, body: SEQ })).status).toBe(200);
    expect((await api.call("GET", seqUrl(id), { token: manager })).status).toBe(200);
    expect((await api.call("GET", seqUrl(id))).status).toBe(401);
    const seller = await member(a.orgId, "seller");
    expect((await api.call("PUT", seqUrl(id), { token: seller, body: SEQ })).status).toBe(403);
  });
});

describe("database guarantees", () => {
  it("rejects deliveries without consent, for the wrong step, and any change to a closed enrolment or a delivery", async () => {
    const a = await register("seq-db");
    const k = await contact(a.token);
    const id = await running(a.token);
    await enroll(a.token, id);
    await runDue(a.token, id);
    const e = (await owner.query("SELECT id, organization_id, contact_id FROM sequence_enrollments WHERE campaign_id = $1", [id])).rows[0];
    const ctx = { organizationId: a.orgId, userId: a.userId, role: "org_admin" };
    const attempt = (sql: string, params: readonly unknown[] = []) => asRuntime(ctx, async (c) => { try { await c.query(sql, [...params]); return "OK"; } catch (err) { return (err as Error).message; } });
    const ins = (step: number) => ["INSERT INTO sequence_deliveries (organization_id, enrollment_id, campaign_id, contact_id, step_no, provider, provider_message_id, sent_at) VALUES ($1,$2,$3,$4,$5,'sandbox','m',now())", [a.orgId, e.id, id, k.contactId, step]] as const;
    expect(await attempt(...ins(1))).toMatch(/duplicate key|current step/); // already delivered / not the current step
    expect(await attempt(...ins(3))).toMatch(/current step/);
    expect(await attempt("INSERT INTO sequence_deliveries (organization_id, enrollment_id, campaign_id, contact_id, step_no, provider, provider_message_id, sent_at) VALUES ($1,$2,$3,$4,2,'ses','m',now())", [a.orgId, e.id, id, k.contactId])).toMatch(/sandbox_only/);
    await withdraw(a.token, k.contactId);
    expect(await attempt(...ins(2))).toMatch(/no consent/);
    expect(await attempt("UPDATE sequence_enrollments SET next_step = 4 WHERE id = $1", [e.id])).toMatch(/one step at a time/);
    expect(await attempt("DELETE FROM sequence_enrollments WHERE id = $1", [e.id])).toMatch(/permission denied|never deleted/);
    expect(await attempt("DELETE FROM sequence_deliveries")).toMatch(/permission denied/);
    // terminal states stay terminal
    clock("2026-11-11T16:00:00.000Z");
    await runDue(a.token, id); // stops: opted_out
    expect(await attempt("UPDATE sequence_enrollments SET state = 'active', stop_reason = NULL, next_due_at = now() WHERE id = $1", [e.id])).toMatch(/invalid enrolment transition/);
    // campaign no longer a draft: steps and schedule are frozen even for the owner role
    expect(await attempt("DELETE FROM sequence_steps WHERE campaign_id = $1", [id])).toMatch(/only a draft campaign/);
    expect(await attempt("UPDATE campaign_schedules SET timezone = 'UTC' WHERE campaign_id = $1", [id])).toMatch(/only a draft campaign/);
  });
});

describe("tenant isolation (RLS) on every new table", () => {
  it("org B sees, changes and inserts nothing of org A in schedules, steps, enrolments and deliveries", async () => {
    const a = await register("seq-iso-a");
    const b = await register("seq-iso-b");
    const k = await contact(a.token);
    const id = await running(a.token);
    await enroll(a.token, id);
    await runDue(a.token, id);
    const tables = ["campaign_schedules", "sequence_steps", "sequence_enrollments", "sequence_deliveries"];
    const asA = { organizationId: a.orgId, userId: a.userId, role: "org_admin" };
    const asB = { organizationId: b.orgId, userId: b.userId, role: "org_admin" };
    for (const t of tables) {
      const seen = await asRuntime(asA, async (c) => Number((await c.query(`SELECT count(*) AS n FROM ${t} WHERE campaign_id = $1`, [id])).rows[0].n));
      expect(seen, `${t} visible to its owner`).toBeGreaterThan(0);
      const leaked = await asRuntime(asB, async (c) => Number((await c.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n));
      expect(leaked, `${t} hidden from another tenant`).toBe(0);
    }
    // org B cannot touch A's rows
    const writes = await asRuntime(asB, async (c) => ({
      enr: (await c.query("UPDATE sequence_enrollments SET next_due_at = now() WHERE campaign_id = $1", [id])).rowCount,
      sch: (await c.query("UPDATE campaign_schedules SET timezone = 'UTC' WHERE campaign_id = $1", [id])).rowCount,
      stp: (await c.query("DELETE FROM sequence_steps WHERE campaign_id = $1", [id])).rowCount,
    }));
    expect(writes).toEqual({ enr: 0, sch: 0, stp: 0 });
    // ... nor insert rows for A (WITH CHECK)
    const e = (await owner.query("SELECT id FROM sequence_enrollments WHERE campaign_id = $1", [id])).rows[0];
    const insert = (sql: string, params: unknown[]) => asRuntime(asB, async (c) => { try { await c.query(sql, [...params]); return "OK"; } catch (err) { return (err as Error).message; } });
    expect(await insert("INSERT INTO campaign_schedules (organization_id, campaign_id, timezone, window_start_min, window_end_min, weekdays, created_by) VALUES ($1,$2,'UTC',0,60,'{1}',$3)", [a.orgId, id, b.userId])).toMatch(/row-level security|violates|draft/);
    expect(await insert("INSERT INTO sequence_steps (organization_id, campaign_id, step_no, delay_hours, subject, body) VALUES ($1,$2,9,0,'s','b')", [a.orgId, id])).toMatch(/row-level security|draft/);
    expect(await insert("INSERT INTO sequence_enrollments (organization_id, campaign_id, contact_id, next_due_at, created_by) VALUES ($1,$2,$3,now(),$4)", [a.orgId, id, k.contactId, b.userId])).toMatch(/row-level security|only a running campaign/);
    expect(await insert("INSERT INTO sequence_deliveries (organization_id, enrollment_id, campaign_id, contact_id, step_no, provider, provider_message_id, sent_at) VALUES ($1,$2,$3,$4,2,'sandbox','m',now())", [a.orgId, e.id, id, k.contactId])).toMatch(/row-level security|current step/);
    // the API agrees: a foreign campaign is a 404
    for (const [m, p] of [["GET", seqUrl(id)], ["GET", seqUrl(id, "/enrollments")], ["POST", seqUrl(id, "/enroll")]] as const) {
      expect((await api.call(m, p, { token: b.token })).status, `${m} ${p}`).toBe(404);
    }
    expect((await runDue(b.token, id)).status).toBe(404);
    expect((await api.call("PUT", seqUrl(id), { token: b.token, body: SEQ })).status).toBe(404);
  });
});

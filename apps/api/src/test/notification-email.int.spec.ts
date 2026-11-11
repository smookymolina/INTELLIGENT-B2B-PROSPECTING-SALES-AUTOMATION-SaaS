import { randomUUID } from "node:crypto";
import net from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationType } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { JobsService } from "../jobs/jobs.service.js";
import { WorkerService } from "../jobs/worker.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/**
 * Notification e-mail: a second SMTP account ("notifications") separate from the outreach one, up to 5 destinations, per-type switches,
 * delivery only by the worker, and failures that never lose the in-app notification. Two local SMTP stubs stand in for the two mailboxes.
 * Run with TEST_DATABASE_URL=postgresql://app:app@localhost:5432/prospecting_notifmail_test
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let api: Api;
const OUT = { port: 2525, user: "ventas@stub.example", pass: "Outreach-S3cret-pass*" };
const NOTI = { port: 587, user: "avisos@stub.example", pass: "Notif-S3cret-pass*" };
type Received = { from: string; to: string[]; data: string };
const outbox: Received[] = [];
const notiBox: Received[] = [];
const stubs: net.Server[] = [];

function startStub(port: number, user: string, pass: string, sink: Received[]): Promise<net.Server> {
  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let loginStep = 0;
    let loginUser = "";
    let current: Received = { from: "", to: [], data: "" };
    const say = (line: string) => socket.write(`${line}\r\n`);
    const check = (u: string, p: string) => say(u === user && p === pass ? "235 2.7.0 ok" : "535 5.7.8 bad credentials");
    say("220 stub ESMTP");
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          sink.push(current);
          current = { from: "", to: [], data: "" };
          say("250 2.0.0 queued");
          continue;
        }
        const nl = buffer.indexOf("\r\n");
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const upper = line.toUpperCase();
        if (loginStep === 1) { loginUser = Buffer.from(line, "base64").toString(); loginStep = 2; say("334 UGFzc3dvcmQ6"); }
        else if (loginStep === 2) { loginStep = 0; check(loginUser, Buffer.from(line, "base64").toString()); }
        else if (upper.startsWith("EHLO")) { say("250-stub"); say("250 AUTH PLAIN LOGIN"); }
        else if (upper.startsWith("AUTH PLAIN")) { const [, u = "", p = ""] = Buffer.from(line.slice(11), "base64").toString().split("\u0000"); check(u, p); }
        else if (upper.startsWith("AUTH LOGIN")) { loginStep = 1; say("334 VXNlcm5hbWU6"); }
        else if (upper.startsWith("MAIL FROM:")) { current.from = line.slice(10).replace(/[<>]/g, "").split(" ")[0] ?? ""; say("250 ok"); }
        else if (upper.startsWith("RCPT TO:")) { current.to.push(line.slice(8).replace(/[<>]/g, "")); say("250 ok"); }
        else if (upper === "DATA") { inData = true; say("354 go"); }
        else if (upper === "QUIT") { say("221 bye"); socket.end(); }
        else say("250 ok");
      }
    });
  });
  return new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", () => resolve(server)));
}

type Account = { token: string; orgId: string; userId: string };
const ctxOf = (a: Account): AuthContext => ({ sessionId: "test", userId: a.userId, organizationId: a.orgId, role: "org_admin", requestId: "test" });
/** Organizations created by this spec: the shared test database also holds other specs' due jobs, which must not be claimed here. */
const myOrgs = new Set<string>();
async function register(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label}` } });
  const me = await api.call("GET", "/me", { token: res.body.token });
  myOrgs.add(res.body.organization.id);
  return { token: res.body.token, orgId: res.body.organization.id, userId: me.body.user.id };
}
async function seller(orgId: string) {
  const m = await seedMember(orgId, "seller");
  const token = (await api.call("POST", "/auth/login", { body: { email: m.email, password: PASSWORD } })).body.token as string;
  return { userId: m.userId, token };
}
const smtp = (s: typeof OUT, over: Record<string, unknown> = {}) => ({ host: "127.0.0.1", port: s.port, secure: false, username: s.user, password: s.pass, fromName: "Stub", fromEmail: s.user, ...over });
const putSmtp = (t: string, purpose: string, body: Record<string, unknown>) => api.call("PUT", `/organization/email-settings?purpose=${purpose}`, { token: t, body });
const getSmtp = (t: string, purpose: string) => api.call("GET", `/organization/email-settings?purpose=${purpose}`, { token: t });
const putDest = (t: string, body: Record<string, unknown>) => api.call("PUT", "/notifications/email-destinations", { token: t, body });
const notify = (a: Account, userId: string, type: NotificationType, title = "Lead nuevo: SECRETO-ACME SA") =>
  api.app.get(NotificationsService).notify(ctxOf(a), { userId, type, title, body: "Detalle privado del prospecto", dedupeKey: `t:${randomUUID()}` });
const jobsOf = async (orgId: string) => (await owner.query("SELECT id, state, attempts, last_error, payload FROM jobs WHERE organization_id = $1 AND type = 'notifications.send_email' ORDER BY created_at", [orgId])).rows as Array<{ id: string; state: string; attempts: number; last_error: string | null; payload: Record<string, string> }>;
/** Claims and runs every due job through the real worker (the only place that sends). */
async function runWorker() {
  const w = api.app.get(WorkerService);
  const claimed = await api.app.get(JobsService).claim(w.workerId, 60, 100, new Date());
  const outcomes: string[] = [];
  for (const j of claimed.filter((x) => myOrgs.has(x.organizationId))) outcomes.push(await w.processOne(j));
  return outcomes;
}
async function ready(label: string) {
  const a = await register(label);
  expect((await putSmtp(a.token, "outreach", smtp(OUT))).status).toBe(200);
  expect((await putSmtp(a.token, "notifications", smtp(NOTI))).status).toBe(200);
  const u = await seller(a.orgId);
  return { a, u };
}

beforeAll(async () => {
  process.env.SMTP_ALLOW_INSECURE_LOCAL = "1";
  stubs.push(await startStub(OUT.port, OUT.user, OUT.pass, outbox), await startStub(NOTI.port, NOTI.user, NOTI.pass, notiBox));
  api = await startApi();
});
afterAll(async () => {
  delete process.env.SMTP_ALLOW_INSECURE_LOCAL;
  await api.close();
  await Promise.all(stubs.map((s) => new Promise((r) => s.close(r))));
});
beforeEach(() => {
  outbox.length = 0;
  notiBox.length = 0;
});

describe("two SMTP accounts per organization", () => {
  it("keeps outreach and notifications accounts separate, encrypted and never returned", async () => {
    const a = await register("nm-accounts");
    expect((await getSmtp(a.token, "notifications")).body).toMatchObject({ configured: false });
    expect((await putSmtp(a.token, "outreach", smtp(OUT))).status).toBe(200);
    const saved = await putSmtp(a.token, "notifications", smtp(NOTI));
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ configured: true, hasPassword: true, username: NOTI.user });
    expect((await getSmtp(a.token, "outreach")).body).toMatchObject({ username: OUT.user });
    for (const r of [saved, await getSmtp(a.token, "notifications"), await getSmtp(a.token, "outreach")]) {
      expect(JSON.stringify(r.body)).not.toContain(NOTI.pass);
      expect(JSON.stringify(r.body)).not.toContain(OUT.pass);
    }
    const o = (await owner.query("SELECT password_enc FROM email_settings WHERE organization_id = $1", [a.orgId])).rows[0] as { password_enc: string };
    const n = (await owner.query("SELECT password_enc FROM notification_smtp_settings WHERE organization_id = $1", [a.orgId])).rows[0] as { password_enc: string };
    expect(n.password_enc.startsWith("v1.")).toBe(true);
    expect(n.password_enc).not.toContain(NOTI.pass);
    // The ciphertext is bound to the purpose: swapping the two stored values makes the accounts unreadable instead of crossing them.
    await owner.query("UPDATE notification_smtp_settings SET password_enc = $2 WHERE organization_id = $1", [a.orgId, o.password_enc]);
    expect((await api.call("POST", "/organization/email-settings/test?purpose=notifications", { token: a.token, body: {} })).status).toBe(503);
    // Verification and deletion act on one account only; a test message cannot be sent from the notifications account inside a request.
    await putSmtp(a.token, "notifications", smtp(NOTI));
    expect((await api.call("POST", "/organization/email-settings/test?purpose=notifications", { token: a.token, body: {} })).body).toMatchObject({ ok: true, sent: false });
    expect((await api.call("POST", "/organization/email-settings/test?purpose=notifications", { token: a.token, body: { sendTo: "x@example.test" } })).status).toBe(400);
    expect((await api.call("DELETE", "/organization/email-settings?purpose=notifications", { token: a.token })).body.configured).toBe(false);
    expect((await getSmtp(a.token, "outreach")).body).toMatchObject({ configured: true });
    expect((await getSmtp(a.token, "bogus")).status).toBe(400);
  });

  it("limits destinations to 5 distinct valid addresses and the settings to organization:update", async () => {
    const { a, u } = await ready("nm-dest");
    expect((await putDest(a.token, { addresses: ["a@x.test", "b@x.test", "c@x.test", "d@x.test", "e@x.test", "f@x.test"] })).status).toBe(400);
    expect((await putDest(a.token, { addresses: ["a@x.test", "A@X.test"] })).status).toBe(400); // duplicates after normalising
    expect((await putDest(a.token, { addresses: ["not-an-email"] })).status).toBe(400);
    const first = await putDest(a.token, { addresses: ["ventas@x.test", "gerencia@x.test"] });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ max: 5, accountConfigured: true });
    expect(first.body.enabledTypes).toHaveLength(6);
    const keepId = first.body.items.find((d: { address: string }) => d.address === "ventas@x.test").id as string;
    const second = await putDest(a.token, { addresses: ["ventas@x.test", "nuevo@x.test"], enabledTypes: ["lead_assigned"] });
    expect(second.body.items.map((d: { address: string }) => d.address).sort()).toEqual(["nuevo@x.test", "ventas@x.test"]);
    expect(second.body.items.find((d: { address: string }) => d.address === "ventas@x.test").id).toBe(keepId);
    expect(second.body.enabledTypes).toEqual(["lead_assigned"]);
    expect((await owner.query("INSERT INTO notification_email_destinations (organization_id, address) VALUES ($1, 'z1@x.test'), ($1, 'z2@x.test'), ($1, 'z3@x.test'), ($1, 'z4@x.test')", [a.orgId]).catch((e: Error) => e)) instanceof Error).toBe(true); // trigger: 2 + 4 > 5
    expect((await api.call("GET", "/notifications/email-destinations", { token: u.token })).status).toBe(403);
    expect((await api.call("PUT", "/notifications/email-destinations", { token: u.token, body: { addresses: [] } })).status).toBe(403);
    expect((await api.call("POST", `/notifications/email-destinations/${keepId}/test`, { token: u.token })).status).toBe(403);
    expect((await api.call("GET", "/notifications/email-destinations")).status).toBe(401);
  });
});

describe("e-mail copy of notifications", () => {
  it("queues in the request path, sends only from the worker, from the notifications account, with a generic subject", async () => {
    const { a, u } = await ready("nm-send");
    expect((await putDest(a.token, { addresses: ["ventas@x.test", "gerencia@x.test"] })).status).toBe(200);
    expect(await notify(a, u.userId, "lead_assigned")).toBe(true);
    // Nothing has been sent by producing the notification: it only queued a job.
    expect(notiBox).toHaveLength(0);
    expect(outbox).toHaveLength(0);
    const queued = await jobsOf(a.orgId);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.state).toBe("queued");
    expect(queued[0]?.payload).toMatchObject({ kind: "notification", type: "lead_assigned" });
    expect(JSON.stringify(queued[0]?.payload)).not.toContain("SECRETO");
    expect(await runWorker()).toEqual(["succeeded"]);
    expect(outbox).toHaveLength(0); // the outreach mailbox is never used for notifications
    expect(notiBox.map((m) => m.to[0]).sort()).toEqual(["gerencia@x.test", "ventas@x.test"]);
    for (const m of notiBox) {
      expect(m.from).toBe(NOTI.user);
      expect(m.data).toContain("Subject: =?UTF-8?Q?Notificaci");
      expect(m.data).not.toContain("SECRETO");
      expect(m.data).not.toContain("Detalle privado");
      expect(m.data).toContain("/notifications");
    }
    expect((await jobsOf(a.orgId))[0]?.state).toBe("succeeded");
    // The in-app notification is still there for its recipient.
    expect((await api.call("GET", "/notifications", { token: u.token })).body.items).toHaveLength(1);
  });

  it("is idempotent per notification and respects the recipient's preference and the per-type switch", async () => {
    const { a, u } = await ready("nm-prefs");
    await putDest(a.token, { addresses: ["ventas@x.test"], enabledTypes: ["lead_assigned", "task_overdue"] });
    const dedupeKey = `same:${randomUUID()}`;
    const svc = api.app.get(NotificationsService);
    const input = { userId: u.userId, type: "lead_assigned" as const, title: "Lead", dedupeKey };
    expect(await svc.notify(ctxOf(a), input)).toBe(true);
    expect(await svc.notify(ctxOf(a), input)).toBe(false); // same dedupe key: no second notification, no second e-mail
    expect(await jobsOf(a.orgId)).toHaveLength(1);
    // The recipient switched task_overdue off in the app: neither the notification nor the e-mail exists.
    await api.call("PUT", "/notifications/preferences", { token: u.token, body: { preferences: [{ type: "task_overdue", enabled: false }] } });
    expect(await notify(a, u.userId, "task_overdue")).toBe(false);
    // The organization did not enable e-mail for sla_breached: the in-app notification exists, no job.
    expect(await notify(a, u.userId, "sla_breached")).toBe(true);
    expect(await jobsOf(a.orgId)).toHaveLength(1);
    expect(await runWorker()).toEqual(["succeeded"]);
    expect(notiBox).toHaveLength(1);
    // With a type switched off after queueing, the worker skips it too.
    expect(await notify(a, u.userId, "lead_assigned")).toBe(true);
    await putDest(a.token, { addresses: ["ventas@x.test"], enabledTypes: ["task_due_soon"] });
    expect(await runWorker()).toEqual(["succeeded"]);
    expect(notiBox).toHaveLength(1);
    expect((await api.call("GET", "/notifications", { token: u.token })).body.items).toHaveLength(3);
    // No destinations at all: nothing is queued.
    await putDest(a.token, { addresses: [] });
    expect(await notify(a, u.userId, "task_due_soon")).toBe(true);
    expect(await jobsOf(a.orgId)).toHaveLength(2);
  });

  it("does not lose the notification when there is no account or SMTP fails: the job retries and ends in the DLQ", async () => {
    const a = await register("nm-fail");
    const u = await seller(a.orgId);
    await putDest(a.token, { addresses: ["ventas@x.test"] });
    // No notifications account yet: queued anyway, fails retryably.
    expect(await notify(a, u.userId, "lead_assigned")).toBe(true);
    expect(await runWorker()).toEqual(["retry"]);
    let [job] = await jobsOf(a.orgId);
    expect(job).toMatchObject({ state: "failed", attempts: 1 });
    // A wrong password at the SMTP server: still retryable, error text carries the category only.
    await putSmtp(a.token, "notifications", smtp(NOTI, { password: "wrong-password-123" }));
    await owner.query("UPDATE jobs SET run_after = now() - interval '1 minute', max_attempts = 2 WHERE id = $1", [job?.id]);
    expect(await runWorker()).toEqual(["dead"]);
    [job] = await jobsOf(a.orgId);
    expect(job?.state).toBe("dead");
    expect(job?.last_error ?? "").not.toContain("wrong-password-123");
    expect(notiBox).toHaveLength(0);
    expect((await api.call("GET", "/notifications", { token: u.token })).body.items).toHaveLength(1);
  });

  it("queues a destination test that only the worker delivers", async () => {
    const a = await register("nm-test");
    const dest = (await putDest(a.token, { addresses: ["ventas@x.test"] })).body.items[0] as { id: string };
    expect((await api.call("POST", `/notifications/email-destinations/${dest.id}/test`, { token: a.token })).status).toBe(409); // no account yet
    await putSmtp(a.token, "notifications", smtp(NOTI));
    const res = await api.call("POST", `/notifications/email-destinations/${dest.id}/test`, { token: a.token });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });
    expect(notiBox).toHaveLength(0);
    expect(await runWorker()).toEqual(["succeeded"]);
    expect(notiBox).toHaveLength(1);
    expect(notiBox[0]?.data).toContain("Subject: Prueba de notificaciones");
    expect(outbox).toHaveLength(0);
    expect((await api.call("GET", "/notifications/email-destinations", { token: a.token })).body.items[0].lastTestAt).not.toBeNull();
  });
});

describe("tenant isolation", () => {
  it("hides destinations, accounts and jobs of other organizations and refuses cross-tenant ids", async () => {
    const { a, u } = await ready("nm-iso-a");
    const b = await register("nm-iso-b");
    const dest = (await putDest(a.token, { addresses: ["ventas@x.test"] })).body.items[0] as { id: string };
    await notify(a, u.userId, "lead_assigned");
    expect((await api.call("GET", "/notifications/email-destinations", { token: b.token })).body).toMatchObject({ items: [], accountConfigured: false });
    expect((await getSmtp(b.token, "notifications")).body).toMatchObject({ configured: false });
    expect((await api.call("POST", `/notifications/email-destinations/${dest.id}/test`, { token: b.token })).status).toBe(404);
    for (const t of ["notification_smtp_settings", "notification_email_destinations", "notification_email_rules"]) {
      const rows = await asRuntime({ organizationId: b.orgId, userId: b.userId, role: "org_admin" }, (c) => c.query(`SELECT 1 FROM ${t} WHERE organization_id = $1`, [a.orgId]));
      expect(rows.rowCount).toBe(0);
    }
    // A member's session may only queue the notification e-mail job of its own organization; no other job type, no other tenant.
    const insert = (org: string, type: string, payload: object) =>
      asRuntime({ organizationId: a.orgId, userId: u.userId, role: "seller" }, (c) => c.query("INSERT INTO jobs (organization_id, type, dedupe_key, payload) VALUES ($1, $2, $3, $4)", [org, type, randomUUID(), JSON.stringify(payload)]));
    await expect(insert(a.orgId, "notifications.send_email", { kind: "notification" })).resolves.toBeTruthy();
    await expect(insert(a.orgId, "retention.purge", {})).rejects.toThrow();
    await expect(insert(a.orgId, "notifications.send_email", { kind: "test" })).rejects.toThrow();
    await expect(insert(b.orgId, "notifications.send_email", { kind: "notification" })).rejects.toThrow();
    await expect(asRuntime({ organizationId: a.orgId, userId: u.userId, role: "seller" }, (c) => c.query("INSERT INTO notification_email_destinations (organization_id, address) VALUES ($1, 'x@x.test')", [a.orgId]))).rejects.toThrow();
  });
});

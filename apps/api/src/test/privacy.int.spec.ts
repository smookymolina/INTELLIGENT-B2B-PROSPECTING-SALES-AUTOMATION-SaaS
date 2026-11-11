import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MembershipRole } from "@prospecting/contracts";
import { EmailChannels } from "../campaigns/channels.js";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** P12-04: per-organization retention (defaults apply without a policy; 0 days disables a class; see retention.int.spec.ts) and data-subject rights (access / restrict / erase). */
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
  return (await api.call("POST", "/auth/login", { body: { email: m.email, password: PASSWORD } })).body.token as string;
}
const iso = (offsetMs = -60_000) => new Date(Date.now() + offsetMs).toISOString();
const outbox = () => api.app.get(EmailChannels).sandbox.outbox;

async function contact(t: string, opts: { consent?: boolean; address?: string; domain?: string } = {}) {
  const domain = opts.domain ?? `prv-${randomUUID().slice(0, 8)}.example`;
  const p = (await api.call("POST", "/prospects", { token: t, body: { name: `Co ${randomUUID().slice(0, 5)}`, domain } })).body as { id: string };
  const c = (await api.call("POST", `/prospects/${p.id}/contacts`, { token: t, body: { address: opts.address ?? `titular@${domain}`, displayName: "Ana Titular", source: "Formulario web, 2026-09-01" } })).body as { id: string; address: string };
  if (opts.consent !== false) {
    const r = await api.call("POST", `/contacts/${c.id}/consent`, { token: t, body: { event: "granted", evidence: "Casilla marcada por ana.titular en el formulario web", occurredAt: iso() } });
    expect(r.status).toBe(201);
  }
  return { prospectId: p.id, contactId: c.id, address: c.address, domain };
}
const open = async (t: string, contactId: string, kind: "access" | "restrict" | "erase") => api.call("POST", "/privacy/requests", { token: t, body: { contactId, kind } });
const complete = (t: string, id: string) => api.call("POST", `/privacy/requests/${id}/complete`, { token: t });
const status = async (cid: string) => (await owner.query("SELECT status, address, display_name, source FROM contacts WHERE id = $1", [cid])).rows[0];
const setPolicy = (t: string, policies: { dataClass: string; retentionDays: number }[]) => api.call("PUT", "/privacy/retention", { token: t, body: { policies } });
const run = (t: string, body: Record<string, unknown> = {}) => api.call("POST", "/privacy/retention/run", { token: t, body });
const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

async function seedOld(orgId: string, userId: string) {
  const job = randomUUID(), oldSession = randomUUID(), newSession = randomUUID(), oldInv = randomUUID(), pendingInv = randomUUID();
  await owner.query(
    `INSERT INTO import_jobs (id, organization_id, kind, mode, status, file_hash, total_rows, created_count, updated_count, unchanged_count, error_count, errors, created_by, created_at)
     VALUES ($1, $2, 'prospects', 'apply', 'applied', repeat('a', 64), 1, 1, 0, 0, 0, '[]', $3, $4)`,
    [job, orgId, userId, days(400)],
  );
  await owner.query("INSERT INTO sessions (id, organization_id, user_id, token_hash, expires_at, revoked_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [oldSession, orgId, userId, randomUUID(), days(300), days(300), days(400)]);
  await owner.query("INSERT INTO sessions (id, organization_id, user_id, token_hash, expires_at, revoked_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [newSession, orgId, userId, randomUUID(), days(-30), null, days(1)]);
  await owner.query("INSERT INTO invitations (id, organization_id, email, role, token_hash, invited_by, expires_at, revoked_at, created_at) VALUES ($1, $2, 'old@example.test', 'viewer', $3, $4, $5, $6, $7)", [oldInv, orgId, randomUUID(), userId, days(380), days(390), days(400)]);
  await owner.query("INSERT INTO invitations (id, organization_id, email, role, token_hash, invited_by, expires_at, created_at) VALUES ($1, $2, 'new@example.test', 'viewer', $3, $4, $5, $6)", [pendingInv, orgId, randomUUID(), userId, days(-7), days(1)]);
  return { job, oldSession, newSession, oldInv, pendingInv };
}
const exists = async (table: string, id: string) => (await owner.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount === 1;

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  delete process.env.EMAIL_PROVIDER;
  await api.close();
});
beforeEach(() => {
  process.env.EMAIL_PROVIDER = "sandbox";
  outbox().length = 0;
});

describe("authorization and validation", () => {
  it("is org_admin only: 401 without token, 403 for every other role, 400 on malformed input", async () => {
    const a = await register("prv-authz");
    const k = await contact(a.token);
    const calls: [string, string, unknown?][] = [
      ["GET", "/privacy/retention"], ["PUT", "/privacy/retention", { policies: [{ dataClass: "sessions", retentionDays: 90 }] }], ["POST", "/privacy/retention/run", {}],
      ["POST", "/privacy/requests", { contactId: k.contactId, kind: "access" }], ["GET", "/privacy/requests"], ["GET", `/privacy/requests/${randomUUID()}`],
      ["POST", `/privacy/requests/${randomUUID()}/complete`], ["POST", `/privacy/requests/${randomUUID()}/reject`, { note: "no procede" }],
      ["POST", `/privacy/contacts/${k.contactId}/lift-restriction`, { note: "ok" }],
    ];
    for (const [m, p, body] of calls) expect((await api.call(m, p, body === undefined ? {} : { body })).status, `${m} ${p} anonymous`).toBe(401);
    for (const role of ["sales_manager", "campaign_manager", "seller", "analyst", "viewer"] as const) {
      const t = await member(a.orgId, role);
      for (const [m, p, body] of calls) expect((await api.call(m, p, { token: t, ...(body === undefined ? {} : { body }) })).status, `${role} ${m} ${p}`).toBe(403);
    }
    expect((await setPolicy(a.token, [{ dataClass: "sessions", retentionDays: 29 }])).status).toBe(400); // below the floor
    expect((await setPolicy(a.token, [{ dataClass: "audit_events", retentionDays: 90 }])).status).toBe(400); // audit is never purgeable
    expect((await setPolicy(a.token, [{ dataClass: "consent_events", retentionDays: 90 }])).status).toBe(400);
    expect((await setPolicy(a.token, [])).status).toBe(400);
    expect((await setPolicy(a.token, [{ dataClass: "sessions", retentionDays: 90 }, { dataClass: "sessions", retentionDays: 91 }])).status).toBe(400);
    expect((await api.call("POST", "/privacy/retention/run", { token: a.token, body: { dryRun: "yes" } })).status).toBe(400);
    expect((await api.call("POST", "/privacy/requests", { token: a.token, body: { contactId: k.contactId, kind: "delete" } })).status).toBe(400);
    expect((await api.call("GET", "/privacy/requests/not-a-uuid", { token: a.token })).status).toBe(400);
    expect((await api.call("GET", "/privacy/requests?status=bogus", { token: a.token })).status).toBe(400);
    const r = (await open(a.token, k.contactId, "access")).body;
    expect((await api.call("POST", `/privacy/requests/${r.id}/reject`, { token: a.token, body: {} })).status).toBe(400); // a reason is required
    expect((await api.call("GET", `/privacy/requests/${r.id}`, { token: a.token })).body.status).toBe("open");
    expect((await open(a.token, randomUUID(), "access")).status).toBe(404);
  });
});

describe("retention policy", () => {
  it("purges NOTHING when every class is disabled (0 days), even with dryRun=false", async () => {
    const a = await register("prv-nopolicy");
    const rows = await seedOld(a.orgId, a.userId);
    expect((await api.call("GET", "/privacy/retention", { token: a.token })).body).toMatchObject({ policies: [], available: ["import_jobs", "sessions", "invitations", "jobs"] });
    expect((await setPolicy(a.token, ["import_jobs", "sessions", "invitations", "jobs"].map((dataClass) => ({ dataClass, retentionDays: 0 })))).status).toBe(200);
    const res = await run(a.token, { dryRun: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: false, classes: [], skipped: ["import_jobs", "sessions", "invitations", "jobs"] });
    for (const [t, id] of [["import_jobs", rows.job], ["sessions", rows.oldSession], ["invitations", rows.oldInv]] as const) expect(await exists(t, id)).toBe(true);
  });

  it("dryRun (the default) reports without deleting; the real run deletes only expired rows of configured classes, and is audited", async () => {
    const a = await register("prv-run");
    const b = await register("prv-run-other");
    const mine = await seedOld(a.orgId, a.userId);
    const theirs = await seedOld(b.orgId, b.userId);
    const put = await setPolicy(a.token, [{ dataClass: "import_jobs", retentionDays: 365 }, { dataClass: "sessions", retentionDays: 90 }, { dataClass: "invitations", retentionDays: 0 }, { dataClass: "jobs", retentionDays: 0 }]);
    expect(put.status).toBe(200);
    expect(put.body.policies).toHaveLength(4);

    const dry = await run(a.token); // default dryRun=true
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.skipped).toEqual(["invitations", "jobs"]); // disabled classes
    expect(dry.body.classes.find((c: { dataClass: string }) => c.dataClass === "import_jobs")).toMatchObject({ eligible: 1, deleted: 0, retentionDays: 365 });
    expect(dry.body.classes.find((c: { dataClass: string }) => c.dataClass === "sessions")).toMatchObject({ eligible: 1, deleted: 0 });
    expect(await exists("import_jobs", mine.job)).toBe(true);
    expect(await exists("sessions", mine.oldSession)).toBe(true);

    const real = await run(a.token, { dryRun: false });
    expect(real.body.classes.find((c: { dataClass: string }) => c.dataClass === "import_jobs")).toMatchObject({ eligible: 1, deleted: 1 });
    expect(await exists("import_jobs", mine.job)).toBe(false);
    expect(await exists("sessions", mine.oldSession)).toBe(false);
    expect(await exists("sessions", mine.newSession)).toBe(true); // an active session is never purged
    expect(await exists("invitations", mine.oldInv)).toBe(true); // invitations are disabled for this organization
    for (const [t, id] of [["import_jobs", theirs.job], ["sessions", theirs.oldSession], ["invitations", theirs.oldInv]] as const) expect(await exists(t, id)).toBe(true); // other tenant untouched
    expect((await api.call("GET", "/me", { token: a.token })).status).toBe(200); // the caller is still logged in

    await setPolicy(a.token, [{ dataClass: "invitations", retentionDays: 30 }]);
    expect((await run(a.token, { dryRun: false })).body.classes.find((c: { dataClass: string }) => c.dataClass === "invitations")).toMatchObject({ deleted: 1 });
    expect(await exists("invitations", mine.oldInv)).toBe(false);
    expect(await exists("invitations", mine.pendingInv)).toBe(true); // a still-valid invitation is kept

    const audit = (await owner.query("SELECT action FROM audit_events WHERE organization_id = $1 AND action LIKE 'privacy.retention.%' ORDER BY created_at", [a.orgId])).rows.map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(["privacy.retention.set", "privacy.retention.dry_run", "privacy.retention.purged"]));
    expect((await api.call("GET", "/privacy/retention", { token: b.token })).body.policies).toEqual([]); // policies are per tenant
  });

  it("with explicit policies a real run deletes exactly the eligible rows (old closed ones) and never the active ones; 'skipped' means only 'disabled'", async () => {
    const a = await register("prv-purge");
    const old = await seedOld(a.orgId, a.userId);
    const extra = { accepted: randomUUID(), expiredOnly: randomUUID(), recentJob: randomUUID(), recentRevoked: randomUUID(), oldExpiredSession: randomUUID() };
    await owner.query("INSERT INTO invitations (id, organization_id, email, role, token_hash, invited_by, expires_at, accepted_at, accepted_by, created_at) VALUES ($1,$2,'acc@example.test','viewer',$3,$4,$5,$6,$4,$7)", [extra.accepted, a.orgId, randomUUID(), a.userId, days(-300), days(350), days(400)]);
    await owner.query("INSERT INTO invitations (id, organization_id, email, role, token_hash, invited_by, expires_at, created_at) VALUES ($1,$2,'exp@example.test','viewer',$3,$4,$5,$6)", [extra.expiredOnly, a.orgId, randomUUID(), a.userId, days(200), days(250)]);
    await owner.query("INSERT INTO sessions (id, organization_id, user_id, token_hash, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6)", [extra.oldExpiredSession, a.orgId, a.userId, randomUUID(), days(150), days(200)]);
    await owner.query("INSERT INTO sessions (id, organization_id, user_id, token_hash, expires_at, revoked_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [extra.recentRevoked, a.orgId, a.userId, randomUUID(), days(-30), days(2), days(5)]);
    await owner.query(
      `INSERT INTO import_jobs (id, organization_id, kind, mode, status, file_hash, total_rows, created_count, updated_count, unchanged_count, error_count, errors, created_by, created_at)
       VALUES ($1, $2, 'prospects', 'apply', 'applied', repeat('b', 64), 1, 1, 0, 0, 0, '[]', $3, $4)`, [extra.recentJob, a.orgId, a.userId, days(3)]);
    expect((await setPolicy(a.token, [{ dataClass: "import_jobs", retentionDays: 90 }, { dataClass: "sessions", retentionDays: 90 }, { dataClass: "invitations", retentionDays: 90 }])).status).toBe(200);

    const dry = await run(a.token);
    expect(dry.body.skipped).toEqual([]);
    const count = (body: { classes: { dataClass: string; eligible: number }[] }, c: string) => body.classes.find((x) => x.dataClass === c)?.eligible;
    expect(count(dry.body, "import_jobs")).toBe(1);
    expect(count(dry.body, "sessions")).toBe(2); // revoked long ago + expired long ago
    expect(count(dry.body, "invitations")).toBe(3); // revoked, accepted, expired
    for (const [t, id] of [["import_jobs", old.job], ["sessions", old.oldSession], ["invitations", old.oldInv]] as const) expect(await exists(t, id)).toBe(true); // dry run deletes nothing

    const real = await run(a.token, { dryRun: false });
    expect(real.body.classes.map((c: { dataClass: string; deleted: number }) => [c.dataClass, c.deleted])).toEqual([["import_jobs", 1], ["sessions", 2], ["invitations", 3], ["jobs", 0]]);
    for (const [t, id] of [["import_jobs", old.job], ["sessions", old.oldSession], ["sessions", extra.oldExpiredSession], ["invitations", old.oldInv], ["invitations", extra.accepted], ["invitations", extra.expiredOnly]] as const) expect(await exists(t, id), `${t} ${id}`).toBe(false);
    for (const [t, id] of [["import_jobs", extra.recentJob], ["sessions", old.newSession], ["sessions", extra.recentRevoked], ["invitations", old.pendingInv]] as const) expect(await exists(t, id), `${t} ${id}`).toBe(true);
  });

  it("enforces the floor and tenant boundaries in the database itself", async () => {
    const a = await register("prv-sql");
    const b = await register("prv-sql-other");
    const seller = await seedMember(a.orgId, "seller");
    await expect(asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, (c) => c.query("INSERT INTO retention_policies (organization_id, data_class, retention_days, updated_by, updated_at) VALUES ($1, 'sessions', 10, $2, now())", [a.orgId, a.userId]))).rejects.toThrow(/retention_min_days/);
    await expect(asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, (c) => c.query("INSERT INTO retention_policies (organization_id, data_class, retention_days, updated_by, updated_at) VALUES ($1, 'audit_events', 90, $2, now())", [a.orgId, a.userId]))).rejects.toThrow(/retention_class/);
    await expect(asRuntime({ organizationId: a.orgId, userId: seller.userId, role: "seller" }, (c) => c.query("INSERT INTO retention_policies (organization_id, data_class, retention_days, updated_by, updated_at) VALUES ($1, 'sessions', 90, $2, now())", [a.orgId, seller.userId]))).rejects.toThrow(/row-level security/);
    await expect(asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, (c) => c.query("INSERT INTO retention_policies (organization_id, data_class, retention_days, updated_by, updated_at) VALUES ($1, 'sessions', 90, $2, now())", [b.orgId, a.userId]))).rejects.toThrow(/row-level security/);
    await expect(asRuntime({ organizationId: a.orgId, userId: seller.userId, role: "seller" }, (c) => c.query("SELECT privacy_purge('sessions', false)"))).rejects.toThrow(/org_admin required/);
    expect(await asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, async (c) => (await c.query("SELECT privacy_purge('sessions', true) AS r")).rows[0].r)).toMatchObject({ source: "default", retentionDays: 30 }); // no policy: the default term
  });
});

describe("data-subject requests", () => {
  it("access: returns the data package once, completes once (second time 409), is audited, and is tenant-isolated", async () => {
    const a = await register("prv-access");
    const b = await register("prv-access-other");
    const k = await contact(a.token);
    const r = await open(a.token, k.contactId, "access");
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: "access", status: "open", contactId: k.contactId, completedAt: null });
    const due = new Date(r.body.dueAt).getTime() - new Date(r.body.requestedAt).getTime();
    expect(Math.round(due / 86_400_000)).toBe(30);
    expect((await open(a.token, k.contactId, "access")).status).toBe(409); // only one open request per contact and kind
    expect((await api.call("GET", `/privacy/requests/${r.body.id}`, { token: b.token })).status).toBe(404);
    expect((await complete(b.token, r.body.id)).status).toBe(404);
    expect((await open(b.token, k.contactId, "access")).status).toBe(404); // someone else's contact

    const done = await complete(a.token, r.body.id);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: "completed", completedBy: a.userId });
    const pkg = done.body.accessPackage;
    expect(pkg.contact).toMatchObject({ id: k.contactId, address: k.address, displayName: "Ana Titular", status: "active" });
    expect(pkg.prospect.id).toBe(k.prospectId);
    expect(pkg.consentEvents).toHaveLength(1);
    expect(pkg.consentEvents[0]).toMatchObject({ event: "granted" });
    expect(JSON.stringify(pkg)).not.toMatch(/token|password|hash/i);
    expect((await complete(a.token, r.body.id)).status).toBe(409);
    expect((await api.call("POST", `/privacy/requests/${r.body.id}/reject`, { token: a.token, body: { note: "tarde" } })).status).toBe(409);
    expect((await api.call("GET", `/privacy/requests/${r.body.id}`, { token: a.token })).body.accessPackage ?? null).toBeNull(); // the package is not stored
    expect((await api.call("GET", "/privacy/requests?status=open", { token: a.token })).body.items).toHaveLength(0);
    expect((await api.call("GET", "/privacy/requests?status=completed", { token: a.token })).body.items).toHaveLength(1);
    expect((await api.call("GET", "/privacy/requests", { token: b.token })).body.items).toHaveLength(0);
    expect((await owner.query("SELECT 1 FROM audit_events WHERE organization_id = $1 AND action = 'privacy.access.completed' AND resource_id = $2", [a.orgId, r.body.id])).rowCount).toBe(1);
    // the contact itself is untouched
    expect((await status(k.contactId)).status).toBe("active");
  });

  it("reject needs a reason, closes the request for good and changes nothing on the contact", async () => {
    const a = await register("prv-reject");
    const k = await contact(a.token);
    const r = (await open(a.token, k.contactId, "erase")).body;
    const rej = await api.call("POST", `/privacy/requests/${r.id}/reject`, { token: a.token, body: { note: "No se pudo verificar la identidad" } });
    expect(rej.status).toBe(200);
    expect(rej.body).toMatchObject({ status: "rejected", note: "No se pudo verificar la identidad", completedBy: a.userId });
    expect((await complete(a.token, r.id)).status).toBe(409);
    expect((await status(k.contactId)).status).toBe("active");
    expect((await open(a.token, k.contactId, "erase")).status).toBe(201); // a new request may be opened afterwards
    await expect(owner.query("UPDATE privacy_requests SET status = 'completed' WHERE id = $1", [r.id])).rejects.toThrow(/closed request cannot change/); // frozen even for the owner
  });

  it("restrict: blocks every send (queued attempts cancelled, eligibility excludes it, the database refuses), survives consent changes, and only an org_admin can lift it, audited", async () => {
    const a = await register("prv-restrict");
    const k = await contact(a.token);
    const camp = (await api.call("POST", "/campaigns", { token: a.token, body: { name: "Oferta", subject: "Hola {{company}}", body: "Para {{company}}. Baja: {{unsubscribe_url}}" } })).body.id as string;
    expect((await api.call("POST", `/campaigns/${camp}/approve`, { token: a.token })).status).toBe(200);
    expect((await api.call("POST", `/campaigns/${camp}/launch`, { token: a.token })).status).toBe(200);
    const queued = await owner.query("SELECT id, state FROM send_attempts WHERE campaign_id = $1", [camp]);
    expect(queued.rows).toEqual([expect.objectContaining({ state: "queued" })]);

    const r = (await open(a.token, k.contactId, "restrict")).body;
    const done = await complete(a.token, r.id);
    expect(done.status).toBe(200);
    expect((await status(k.contactId)).status).toBe("restricted");
    expect((await owner.query("SELECT state FROM send_attempts WHERE id = $1", [queued.rows[0].id])).rows[0].state).toBe("cancelled");
    await api.call("POST", `/campaigns/${camp}/dispatch`, { token: a.token });
    expect(outbox()).toHaveLength(0);

    // a new campaign does not reach it
    const camp2 = (await api.call("POST", "/campaigns", { token: a.token, body: { name: "Otra", subject: "Hola", body: "Baja: {{unsubscribe_url}}" } })).body.id as string;
    const preview = await api.call("GET", `/campaigns/${camp2}/preview`, { token: a.token });
    expect(preview.body).toMatchObject({ eligible: 0, excluded: { opted_out: 1 } });
    await api.call("POST", `/campaigns/${camp2}/approve`, { token: a.token });
    await api.call("POST", `/campaigns/${camp2}/launch`, { token: a.token });
    expect((await owner.query("SELECT 1 FROM send_attempts WHERE campaign_id = $1", [camp2])).rowCount).toBe(0);

    // consent events cannot lift it, neither can a hand-made UPDATE; the database also refuses to mark an attempt as sent
    expect((await api.call("POST", `/contacts/${k.contactId}/consent`, { token: a.token, body: { event: "withdrawn", evidence: "Pide no recibir mas", occurredAt: iso(-20_000) } })).body.status).toBe("restricted");
    expect((await api.call("POST", `/contacts/${k.contactId}/consent`, { token: a.token, body: { event: "granted", evidence: "Vuelve a aceptar", occurredAt: iso(-10_000) } })).body.status).toBe("restricted");
    await expect(asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, (c) => c.query("UPDATE contacts SET status = 'active' WHERE id = $1", [k.contactId]))).rejects.toThrow(/privacy workflow/);
    await expect(asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, (c) => c.query("SELECT privacy_lift_restriction($1)", [randomUUID()]))).rejects.toThrow(/contact not found/);
    expect((await api.call("POST", `/privacy/contacts/${k.contactId}/lift-restriction`, { token: await member(a.orgId, "sales_manager"), body: { note: "x y z" } })).status).toBe(403);

    // lifting: audited with its reason, restores to the status the consent ledger implies (granted last -> active)
    const lift = await api.call("POST", `/privacy/contacts/${k.contactId}/lift-restriction`, { token: a.token, body: { note: "El titular retiro su peticion" } });
    expect(lift.status).toBe(200);
    expect(lift.body).toMatchObject({ id: k.contactId, status: "active", consent: "granted" });
    expect((await api.call("POST", `/privacy/contacts/${k.contactId}/lift-restriction`, { token: a.token, body: { note: "otra vez" } })).status).toBe(409);
    expect((await owner.query("SELECT metadata FROM audit_events WHERE organization_id = $1 AND action = 'privacy.restriction.lifted'", [a.orgId])).rows[0].metadata).toMatchObject({ note: "El titular retiro su peticion" });
  });

  it("erase: anonymizes the contact irreversibly, keeps a non-reversible fingerprint so the address can never be contacted again, and keeps the consent ledger without personal data", async () => {
    const a = await register("prv-erase");
    const b = await register("prv-erase-other");
    const k = await contact(a.token, { address: "Titular.Erase@Empresa-Erase.example" });
    const r = (await open(a.token, k.contactId, "erase")).body;
    expect((await complete(b.token, r.id)).status).toBe(404);
    const done = await complete(a.token, r.id);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("completed");

    const c = await status(k.contactId);
    expect(c.status).toBe("erased");
    expect(c.display_name).toBeNull();
    expect(c.address).not.toMatch(/titular|empresa-erase/i);
    expect(c.source).toBe("erased");
    const ledger = (await owner.query("SELECT event, evidence, recorded_by FROM consent_events WHERE contact_id = $1", [k.contactId])).rows;
    expect(ledger).toHaveLength(1); // the ledger is kept...
    expect(ledger[0].event).toBe("granted");
    expect(JSON.stringify(ledger)).not.toMatch(/ana\.titular/i); // ...without the free text that named the person
    const fp = (await owner.query("SELECT address_hash FROM erased_addresses WHERE organization_id = $1", [a.orgId])).rows;
    expect(fp).toHaveLength(1);
    expect(fp[0].address_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fp[0].address_hash).not.toContain("titular");

    // cannot come back: same prospect, another prospect, different case
    expect((await api.call("POST", `/prospects/${k.prospectId}/contacts`, { token: a.token, body: { address: "titular.erase@empresa-erase.example", source: "Reimportado desde CRM" } })).status).toBe(409);
    const other = (await api.call("POST", "/prospects", { token: a.token, body: { name: "Otra SL", domain: `otra-${randomUUID().slice(0, 6)}.example` } })).body.id;
    expect((await api.call("POST", `/prospects/${other}/contacts`, { token: a.token, body: { address: "TITULAR.ERASE@EMPRESA-ERASE.EXAMPLE", source: "Reimportado desde CRM" } })).status).toBe(409);
    expect((await api.call("POST", `/contacts/${k.contactId}/consent`, { token: a.token, body: { event: "granted", evidence: "Intento tras borrado", occurredAt: iso() } })).status).toBe(409);
    expect((await open(a.token, k.contactId, "access")).status).toBe(409); // nothing left to request
    expect((await complete(a.token, r.id)).status).toBe(409); // idempotent
    const listed = (await api.call("GET", `/prospects/${k.prospectId}/contacts`, { token: a.token })).body.items;
    expect(listed[0]).toMatchObject({ id: k.contactId, status: "erased", displayName: null });

    // irreversible even for direct SQL
    await expect(asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, (cl) => cl.query("UPDATE contacts SET status = 'active' WHERE id = $1", [k.contactId]))).rejects.toThrow(/erased contact cannot change|privacy workflow/);
    await expect(asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, (cl) => cl.query("UPDATE contacts SET display_name = 'Ana' WHERE id = $1", [k.contactId]))).rejects.toThrow(/erased contact cannot change/);
    await expect(owner.query("UPDATE contacts SET status = 'active' WHERE id = $1", [k.contactId])).rejects.toThrow(/erased contact cannot change/);
    await expect(asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, (cl) => cl.query("DELETE FROM erased_addresses"))).rejects.toThrow(/permission denied/);
    await expect(asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, (cl) => cl.query("SELECT privacy_erase_contact($1, $2)", [k.contactId, "0".repeat(64)]))).rejects.toThrow(/already erased/);

    // the fingerprint is per organization: another tenant is not affected and cannot see it
    expect((await contact(b.token, { address: "Titular.Erase@Empresa-Erase.example", consent: false })).contactId).toBeTruthy();
    await expect(asRuntime({ organizationId: b.orgId, userId: b.userId, role: "org_admin" }, (cl) => cl.query("SELECT count(*)::int AS n FROM erased_addresses"))).rejects.toThrow(/permission denied/);
    await expect(asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, (cl) => cl.query("SELECT address_hash FROM erased_addresses"))).rejects.toThrow(/permission denied/);
  });

  it("hardening: keyed fingerprint (not the old org-salted SHA-256), +tag aliases are blocked, the contact DTO shows no consent for restricted/erased, and the registration check cannot be skipped", async () => {
    const a = await register("prv-hard");
    const domain = `hard-${randomUUID().slice(0, 8)}.example`;
    const k = await contact(a.token, { address: `victima+1@${domain}`, domain });
    await complete(a.token, (await open(a.token, k.contactId, "erase")).body.id);
    const fp = (await owner.query("SELECT address_hash FROM erased_addresses WHERE organization_id = $1", [a.orgId])).rows[0].address_hash as string;
    const { createHash } = await import("node:crypto");
    for (const guess of [`victima+1@${domain}`, `victima@${domain}`]) {
      expect(fp).not.toBe(createHash("sha256").update(`${a.orgId}:${guess}`).digest("hex")); // old, guessable scheme
      expect(fp).not.toBe(createHash("sha256").update(guess).digest("hex"));
    }
    const p2 = (await api.call("POST", "/prospects", { token: a.token, body: { name: "Otra", domain: `otra-${randomUUID().slice(0, 6)}.example` } })).body.id;
    const add = (address: string) => api.call("POST", `/prospects/${p2}/contacts`, { token: a.token, body: { address, source: "Reimportado" } });
    expect((await add(`victima@${domain}`)).status).toBe(409);
    expect((await add(`VICTIMA+otra@${domain}`)).status).toBe(409);
    expect((await add(`vict.ima+2@${domain}`)).status).toBe(201); // the dot is provider-specific: a different address

    // the database refuses an insert whose erased-address check did not run
    await expect(asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, (c) =>
      c.query("INSERT INTO contacts (organization_id, prospect_id, channel, address, address_key, source, created_by, updated_at) VALUES ($1,$2,'email','x@y.example','x@y.example','s',$3, now())", [a.orgId, p2, a.userId]))).rejects.toThrow(/check must run/);

    // DTO: restricted and erased show no usable consent even though the ledger says granted
    const r = await contact(a.token);
    await complete(a.token, (await open(a.token, r.contactId, "restrict")).body.id);
    const dto = async (prospectId: string) => (await api.call("GET", `/prospects/${prospectId}/contacts`, { token: a.token })).body.items[0];
    expect(await dto(r.prospectId)).toMatchObject({ status: "restricted", consent: "none", consentAt: null });
    expect(await dto(k.prospectId)).toMatchObject({ status: "erased", consent: "none", consentAt: null });
  });

  it("lifting a restriction restores the previous status: bounced stays bounced, opted_out stays opted_out", async () => {
    const a = await register("prv-lift");
    const bounced = await contact(a.token);
    await owner.query("UPDATE contacts SET status = 'bounced' WHERE id = $1", [bounced.contactId]);
    const out = await contact(a.token);
    await api.call("POST", `/contacts/${out.contactId}/consent`, { token: a.token, body: { event: "withdrawn", evidence: "Pide baja", occurredAt: iso(-1000) } });
    const plain = await contact(a.token);
    for (const k of [bounced, out, plain]) {
      expect((await complete(a.token, (await open(a.token, k.contactId, "restrict")).body.id)).status).toBe(200);
      expect((await status(k.contactId)).status).toBe("restricted");
    }
    const lift = async (id: string) => (await api.call("POST", `/privacy/contacts/${id}/lift-restriction`, { token: a.token, body: { note: "Titular retira peticion" } })).body;
    expect(await lift(bounced.contactId)).toMatchObject({ status: "bounced" });
    expect(await lift(out.contactId)).toMatchObject({ status: "opted_out", consent: "withdrawn" });
    expect(await lift(plain.contactId)).toMatchObject({ status: "active", consent: "granted" });
    expect((await owner.query("SELECT count(*)::int AS n FROM contacts WHERE organization_id = $1 AND restricted_from IS NOT NULL", [a.orgId])).rows[0].n).toBe(0);
    const pre = await api.call("GET", "/campaigns", { token: a.token }); // sanity: API alive
    expect(pre.status).toBe(200);
  });

  it("the erase/restrict functions refuse to run without an open matching request, for non-admins and across tenants", async () => {
    const a = await register("prv-fn");
    const b = await register("prv-fn-other");
    const k = await contact(a.token);
    const admin = { organizationId: a.orgId, userId: a.userId, role: "org_admin" };
    await expect(asRuntime(admin, (c) => c.query("SELECT privacy_erase_contact($1, $2)", [k.contactId, "0".repeat(64)]))).rejects.toThrow(/no open erase request/);
    await expect(asRuntime(admin, (c) => c.query("SELECT privacy_restrict_contact($1)", [k.contactId]))).rejects.toThrow(/no open restrict request/);
    await open(a.token, k.contactId, "access");
    await expect(asRuntime(admin, (c) => c.query("SELECT privacy_erase_contact($1, $2)", [k.contactId, "0".repeat(64)]))).rejects.toThrow(/no open erase request/); // another kind does not count
    await expect(asRuntime({ ...admin, role: "seller" }, (c) => c.query("SELECT privacy_erase_contact($1, $2)", [k.contactId, "0".repeat(64)]))).rejects.toThrow(/org_admin required/);
    await expect(asRuntime({ organizationId: b.orgId, userId: b.userId, role: "org_admin" }, (c) => c.query("SELECT privacy_erase_contact($1, $2)", [k.contactId, "0".repeat(64)]))).rejects.toThrow(/contact not found/);
    await expect(asRuntime({ organizationId: a.orgId, userId: a.userId, role: "seller" }, (c) => c.query("INSERT INTO privacy_requests (organization_id, contact_id, kind, requested_by, due_at) VALUES ($1, $2, 'erase', $3, now())", [a.orgId, k.contactId, a.userId]))).rejects.toThrow(/row-level security/);
    expect((await status(k.contactId)).status).toBe("active");
  });
});

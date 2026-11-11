import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AudiencePreviewDto, type MembershipRole } from "@prospecting/contracts";
import { EmailChannels } from "../campaigns/channels.js";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** F7 domain (sandbox email only): contacts, consent ledger, approval, eligibility at preview/launch/send time, frequency cap, unsubscribe. */
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
const outbox = () => api.app.get(EmailChannels).sandbox.outbox;
const iso = (offsetMs = -60_000) => new Date(Date.now() + offsetMs).toISOString();

/** A prospect with one contact; `consent` records a granted consent with evidence when asked. */
async function contact(t: string, opts: { consent?: boolean; name?: string; domain?: string } = {}) {
  const domain = opts.domain ?? `cmp-${randomUUID().slice(0, 8)}.example`;
  const p = (await api.call("POST", "/prospects", { token: t, body: { name: opts.name ?? `Co ${randomUUID().slice(0, 5)}`, domain } })).body as { id: string; domain: string };
  const c = (await api.call("POST", `/prospects/${p.id}/contacts`, { token: t, body: { address: `compras@${domain}`, displayName: "Compras", source: "Formulario web, 2026-09-01" } })).body as { id: string; address: string };
  if (opts.consent !== false) {
    const r = await api.call("POST", `/contacts/${c.id}/consent`, { token: t, body: { event: "granted", evidence: "Casilla marcada en el formulario web, 2026-09-01", occurredAt: iso() } });
    expect(r.status).toBe(201);
  }
  return { prospectId: p.id, contactId: c.id, address: c.address, domain };
}
const consent = (t: string, cid: string, event: "granted" | "withdrawn", offset = -30_000) =>
  api.call("POST", `/contacts/${cid}/consent`, { token: t, body: { event, evidence: `Registro manual ${event}`, occurredAt: iso(offset) } });
const draft = async (t: string, over: Record<string, unknown> = {}) =>
  (await api.call("POST", "/campaigns", { token: t, body: { name: "Lanzamiento", subject: "Hola {{company}}", body: "Para {{company}}: nuestra oferta. Baja: {{unsubscribe_url}}", ...over } })).body as { id: string };
const approved = async (t: string, over: Record<string, unknown> = {}) => {
  const c = await draft(t, over);
  expect((await api.call("POST", `/campaigns/${c.id}/approve`, { token: t })).status).toBe(200);
  return c.id;
};
const launch = (t: string, id: string) => api.call("POST", `/campaigns/${id}/launch`, { token: t });
const dispatch = (t: string, id: string, body?: Record<string, unknown>) => api.call("POST", `/campaigns/${id}/dispatch`, { token: t, ...(body ? { body } : {}) });

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

describe("contacts and the consent ledger", () => {
  it("never implies consent: a contact starts with none, and only recorded evidence changes it", async () => {
    const a = await register("cmp-consent");
    const k = await contact(a.token, { consent: false });
    const listed = (await api.call("GET", `/prospects/${(await owner.query("SELECT prospect_id FROM contacts WHERE id = $1", [k.contactId])).rows[0].prospect_id}/contacts`, { token: a.token })).body.items;
    expect(listed[0]).toMatchObject({ id: k.contactId, status: "active", consent: "none", consentAt: null, source: "Formulario web, 2026-09-01" });

    expect((await consent(a.token, k.contactId, "granted")).body).toMatchObject({ status: "active", consent: "granted" });
    const out = await consent(a.token, k.contactId, "withdrawn", -10_000);
    expect(out.body).toMatchObject({ status: "opted_out", consent: "withdrawn" }); // the ledger moved the contact status
    expect((await consent(a.token, k.contactId, "granted", -5_000)).body).toMatchObject({ status: "active", consent: "granted" }); // a NEW consent is needed to return

    const rows = await owner.query("SELECT event, recorded_by FROM consent_events WHERE contact_id = $1 ORDER BY created_at", [k.contactId]);
    expect(rows.rows.map((r) => r.event)).toEqual(["granted", "withdrawn", "granted"]);
    expect(rows.rows.every((r) => r.recorded_by === a.userId)).toBe(true);
    const audit = await owner.query("SELECT action FROM audit_events WHERE organization_id = $1 AND action LIKE 'consent.%'", [a.orgId]);
    expect(audit.rowCount).toBe(3);
  });

  it("validates input strictly and keeps the ledger append-only", async () => {
    const a = await register("cmp-valid");
    const k = await contact(a.token, { consent: false });
    const bad = (body: Record<string, unknown>) => api.call("POST", `/contacts/${k.contactId}/consent`, { token: a.token, body });
    expect((await bad({ event: "granted", evidence: "x", occurredAt: iso() })).status).toBe(400); // evidence too short
    expect((await bad({ event: "granted", evidence: "Formulario web", occurredAt: iso(86_400_000) })).status).toBe(400); // future
    expect((await bad({ event: "granted", evidence: "Formulario web", occurredAt: "ayer" })).status).toBe(400);
    expect((await bad({ event: "maybe", evidence: "Formulario web", occurredAt: iso() })).status).toBe(400);
    expect((await bad({ event: "granted", evidence: "Formulario web", occurredAt: iso(), recordedBy: randomUUID() })).status).toBe(400);
    const pid = (await owner.query("SELECT prospect_id FROM contacts WHERE id = $1", [k.contactId])).rows[0].prospect_id as string;
    for (const body of [{ address: "no-es-correo", source: "web 1" }, { address: "a@example.com" }, { address: "a@example.com", source: "xx" }, { address: "a@example.com", source: "web 1", status: "opted_out" }]) {
      expect((await api.call("POST", `/prospects/${pid}/contacts`, { token: a.token, body })).status).toBe(400);
    }
    expect((await api.call("POST", `/prospects/${pid}/contacts`, { token: a.token, body: { address: k.address.toUpperCase(), source: "otro formulario" } })).status).toBe(409); // case-insensitive duplicate
    expect((await api.call("POST", `/prospects/${randomUUID()}/contacts`, { token: a.token, body: { address: "x@example.com", source: "web 1" } })).status).toBe(404);

    await consent(a.token, k.contactId, "granted");
    const ctx = { organizationId: a.orgId, userId: a.userId, role: "org_admin" };
    const denied = (sql: string) => asRuntime(ctx, async (c) => c.query(sql, [k.contactId]).then(() => "NO ERROR", (e: Error) => e.message));
    expect(await denied("UPDATE consent_events SET event = 'granted' WHERE contact_id = $1")).toMatch(/permission denied/);
    expect(await denied("DELETE FROM consent_events WHERE contact_id = $1")).toMatch(/permission denied/);
    // a person cannot flip an opted-out contact back by hand either
    await consent(a.token, k.contactId, "withdrawn", -1_000);
    expect(await asRuntime(ctx, async (c) => c.query("UPDATE contacts SET status = 'active' WHERE id = $1", [k.contactId]).then(() => "NO ERROR", (e: Error) => e.message))).toMatch(/new recorded consent/);
  });

  it("is restricted by role and tenant", async () => {
    const a = await register("cmp-acl");
    const k = await contact(a.token, { consent: false });
    const pid = (await owner.query("SELECT prospect_id FROM contacts WHERE id = $1", [k.contactId])).rows[0].prospect_id as string;
    const seller = await member(a.orgId, "seller");
    const analyst = await member(a.orgId, "analyst");
    const manager = await member(a.orgId, "campaign_manager");
    expect((await api.call("POST", `/prospects/${pid}/contacts`, { token: seller, body: { address: "z@example.com", source: "web 1" } })).status).toBe(404); // a seller cannot see another user's prospect (owner visibility)
    expect((await api.call("GET", `/prospects/${pid}/contacts`, { token: analyst })).status).toBe(403); // contact data is not for analysts
    expect((await consent(seller, k.contactId, "granted")).status).toBe(404);
    expect((await api.call("GET", `/prospects/${pid}/contacts`, { token: manager })).status).toBe(200);
    const other = await register("cmp-acl-other");
    expect((await api.call("GET", `/prospects/${pid}/contacts`, { token: other.token })).status).toBe(404);
    expect((await consent(other.token, k.contactId, "granted")).status).toBe(404);
    expect((await api.call("GET", `/prospects/${pid}/contacts`)).status).toBe(401);
  });
});

describe("campaign lifecycle and approval", () => {
  it("requires the unsubscribe placeholder, edits only drafts, and only approvers approve (stamped by the database)", async () => {
    const a = await register("cmp-life");
    expect((await api.call("POST", "/campaigns", { token: a.token, body: { name: "x", subject: "s", body: "sin enlace de baja" } })).status).toBe(400);
    expect((await api.call("POST", "/campaigns", { token: a.token, body: { name: "x", subject: "s", body: "{{unsubscribe_url}}", state: "approved" } })).status).toBe(400);
    const c = await draft(a.token);
    expect((await api.call("PATCH", `/campaigns/${c.id}`, { token: a.token, body: { subject: "Nuevo asunto" } })).body.subject).toBe("Nuevo asunto");
    expect((await api.call("PATCH", `/campaigns/${c.id}`, { token: a.token, body: { body: "sin baja" } })).status).toBe(400);
    expect((await api.call("PATCH", `/campaigns/${c.id}`, { token: a.token, body: {} })).status).toBe(400);

    const manager = await member(a.orgId, "campaign_manager");
    expect((await api.call("POST", `/campaigns/${c.id}/approve`, { token: manager })).status).toBe(403); // campaign_manager has no approve right
    expect((await launch(a.token, c.id)).status).toBe(409); // not approved yet
    const ok = await api.call("POST", `/campaigns/${c.id}/approve`, { token: a.token });
    expect(ok.body).toMatchObject({ state: "approved" });
    expect(ok.body.approvedAt).toBeTruthy();
    expect((await owner.query("SELECT approved_by FROM campaigns WHERE id = $1", [c.id])).rows[0].approved_by).toBe(a.userId);
    expect((await api.call("PATCH", `/campaigns/${c.id}`, { token: a.token, body: { subject: "tarde" } })).status).toBe(409); // frozen after approval
    expect((await api.call("POST", `/campaigns/${c.id}/approve`, { token: a.token })).status).toBe(409);
    expect((await api.call("POST", `/campaigns/${c.id}/resume`, { token: a.token })).status).toBe(409);
    const viewer = await member(a.orgId, "viewer");
    expect((await api.call("GET", "/campaigns", { token: viewer })).status).toBe(403);
    expect((await api.call("GET", "/campaigns", { token: manager })).body.items.map((x: { id: string }) => x.id)).toEqual([c.id]);
    const other = await register("cmp-life-other");
    expect((await api.call("GET", `/campaigns/${c.id}`, { token: other.token })).status).toBe(404);
  });
});

describe("eligibility, launch and dispatch", () => {
  it("explains who is excluded, queues only the eligible once, and sends rendered emails with a valid unsubscribe link", async () => {
    const a = await register("cmp-flow");
    const ok1 = await contact(a.token, { name: "Alfa SA" });
    const ok2 = await contact(a.token, { name: "Beta SA" });
    await contact(a.token, { consent: false });
    const optedOut = await contact(a.token);
    await consent(a.token, optedOut.contactId, "withdrawn", -10_000);
    const suppressed = await contact(a.token);
    await api.call("POST", "/suppressions", { token: a.token, body: { kind: "domain", value: suppressed.domain, reason: "pidió no ser contactado" } });
    const id = await approved(a.token);

    const preview = await api.call("GET", `/campaigns/${id}/preview`, { token: a.token });
    expect(AudiencePreviewDto.safeParse(preview.body).success).toBe(true);
    expect(preview.body).toEqual({ total: 5, eligible: 2, excluded: { no_consent: 1, opted_out: 1, bounced: 0, suppressed: 1, recently_contacted: 0, already_in_campaign: 0 } });

    const started = await launch(a.token, id);
    expect(started.body).toMatchObject({ state: "running", attempts: { queued: 2, sent: 0 } });
    expect(started.body.launchedAt).toBeTruthy();
    expect((await launch(a.token, id)).status).toBe(409); // cannot be launched twice
    expect((await api.call("GET", `/campaigns/${id}/preview`, { token: a.token })).body.excluded.already_in_campaign).toBe(2);

    const res = await dispatch(a.token, id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ processed: 2, sent: 2, failed: 0, skipped: {}, remainingQueued: 0, campaignState: "completed" });
    expect(outbox().map((m) => m.to).sort()).toEqual([ok1.address, ok2.address].sort());
    const mail = outbox().find((m) => m.to === ok1.address)!;
    expect(mail.subject).toBe("Hola Alfa SA");
    expect(mail.body).toContain("Para Alfa SA:");
    expect(mail.body).not.toContain("{{");
    const link = new URL(/https?:\/\/\S+/.exec(mail.body)![0]);
    expect(link.pathname).toBe("/unsubscribe");
    expect(link.searchParams.get("o")).toBe(a.orgId);
    expect(link.searchParams.get("c")).toBe(ok1.contactId);

    const attempts = (await api.call("GET", `/campaigns/${id}/attempts?state=sent`, { token: a.token })).body.items;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ state: "sent", skipReason: null });
    expect(attempts[0].providerMessageId).toMatch(/^sbx_[0-9a-f]{16}$/);
    expect((await dispatch(a.token, id)).status).toBe(409); // completed
    expect(outbox()).toHaveLength(2); // no duplicates
    expect((await api.call("GET", `/campaigns/${id}`, { token: a.token })).body.attempts).toMatchObject({ sent: 2, queued: 0 });
  });

  it("re-checks consent, opt-out and suppression for EACH send, not only at launch", async () => {
    const a = await register("cmp-recheck");
    const keep = await contact(a.token);
    const withdrawn = await contact(a.token);
    const suppressed = await contact(a.token);
    const id = await approved(a.token);
    expect((await launch(a.token, id)).body.attempts.queued).toBe(3);

    await consent(a.token, withdrawn.contactId, "withdrawn", -1_000); // opts out AFTER launch
    await api.call("POST", "/suppressions", { token: a.token, body: { kind: "domain", value: suppressed.domain, reason: "baja posterior" } });
    const res = await dispatch(a.token, id);
    expect(res.body).toMatchObject({ processed: 3, sent: 1, skipped: { opted_out: 1, suppressed: 1 }, campaignState: "completed" });
    expect(outbox().map((m) => m.to)).toEqual([keep.address]);
    const skipped = (await api.call("GET", `/campaigns/${id}/attempts?state=skipped`, { token: a.token })).body.items;
    expect(skipped.map((s: { skipReason: string }) => s.skipReason).sort()).toEqual(["opted_out", "suppressed"]);
  });

  it("honours the frequency cap across campaigns", async () => {
    const a = await register("cmp-freq");
    await contact(a.token);
    const first = await approved(a.token);
    await launch(a.token, first);
    expect((await dispatch(a.token, first)).body.sent).toBe(1);

    const second = await approved(a.token, { name: "Segunda", minDaysBetween: 7 });
    expect((await api.call("GET", `/campaigns/${second}/preview`, { token: a.token })).body).toMatchObject({ eligible: 0, excluded: { recently_contacted: 1 } });
    const free = await approved(a.token, { name: "Sin tope", minDaysBetween: 0 });
    expect((await api.call("GET", `/campaigns/${free}/preview`, { token: a.token })).body.eligible).toBe(1);
  });

  it("pauses, resumes and cancels (queued attempts are cancelled and never sent)", async () => {
    const a = await register("cmp-pause");
    await contact(a.token);
    await contact(a.token);
    const id = await approved(a.token);
    await launch(a.token, id);
    expect((await api.call("POST", `/campaigns/${id}/pause`, { token: a.token })).body.state).toBe("paused");
    expect((await dispatch(a.token, id)).status).toBe(409);
    expect((await api.call("POST", `/campaigns/${id}/pause`, { token: a.token })).status).toBe(409);
    expect((await api.call("POST", `/campaigns/${id}/resume`, { token: a.token })).body.state).toBe("running");
    expect((await dispatch(a.token, id, { limit: 1 })).body).toMatchObject({ processed: 1, sent: 1, remainingQueued: 1, campaignState: "running" });
    const cancelled = await api.call("POST", `/campaigns/${id}/cancel`, { token: a.token });
    expect(cancelled.body).toMatchObject({ state: "cancelled", attempts: { sent: 1, cancelled: 1, queued: 0 } });
    expect((await dispatch(a.token, id)).status).toBe(409);
    expect((await api.call("POST", `/campaigns/${id}/cancel`, { token: a.token })).status).toBe(409);
    expect(outbox()).toHaveLength(1);
    expect((await api.call("POST", `/campaigns/${id}/dispatch`, { token: a.token, body: { limit: 0 } })).status).toBe(400);
  });

  it("answers 503 without an email provider and refuses roles without campaigns:manage", async () => {
    const a = await register("cmp-prov");
    await contact(a.token);
    const id = await approved(a.token);
    await launch(a.token, id);
    process.env.EMAIL_PROVIDER = "none";
    expect((await dispatch(a.token, id)).status).toBe(503);
    expect((await api.call("GET", `/campaigns/${id}/attempts?state=queued`, { token: a.token })).body.items).toHaveLength(1); // nothing was consumed
    process.env.EMAIL_PROVIDER = "sandbox";
    const analyst = await member(a.orgId, "analyst");
    const seller = await member(a.orgId, "seller");
    for (const t of [analyst, seller]) {
      expect((await dispatch(t, id)).status).toBe(403);
      expect((await api.call("POST", "/campaigns", { token: t, body: { name: "x", subject: "s", body: "{{unsubscribe_url}}" } })).status).toBe(403);
    }
  });
});

describe("unsubscribe and database defences", () => {
  it("a signed link withdraws consent without a session; forged or unknown requests look identical and change nothing", async () => {
    const a = await register("cmp-unsub");
    const k = await contact(a.token);
    const id = await approved(a.token);
    await launch(a.token, id);
    await dispatch(a.token, id);
    const url = new URL(/https?:\/\/\S+/.exec(outbox()[0]!.body)![0]);
    const body = { org: url.searchParams.get("o"), contact: url.searchParams.get("c"), sig: url.searchParams.get("s") };

    const forged = await api.call("POST", "/public/unsubscribe", { body: { ...body, sig: "0".repeat(64) } });
    expect(forged.status).toBe(204);
    const wrongContact = await api.call("POST", "/public/unsubscribe", { body: { ...body, contact: randomUUID() } });
    expect(wrongContact.status).toBe(204);
    expect((await owner.query("SELECT status FROM contacts WHERE id = $1", [k.contactId])).rows[0].status).toBe("active");

    expect((await api.call("POST", "/public/unsubscribe", { body })).status).toBe(204);
    expect((await api.call("POST", "/public/unsubscribe", { body })).status).toBe(204); // idempotent
    expect((await owner.query("SELECT status FROM contacts WHERE id = $1", [k.contactId])).rows[0].status).toBe("opted_out");
    const ledger = await owner.query("SELECT event, recorded_by, evidence FROM consent_events WHERE contact_id = $1 ORDER BY created_at DESC", [k.contactId]);
    expect(ledger.rows[0]).toMatchObject({ event: "withdrawn", recorded_by: null, evidence: "self-service unsubscribe link" });
    expect(ledger.rows.filter((r) => r.event === "withdrawn")).toHaveLength(1); // the repeat added nothing

    expect((await api.call("POST", "/public/unsubscribe", { body: { ...body, sig: "short" } })).status).toBe(400);
    expect((await api.call("POST", "/public/unsubscribe", { body: { ...body, extra: 1 } })).status).toBe(400);
    const second = await approved(a.token, { name: "Otra", minDaysBetween: 0 });
    expect((await api.call("GET", `/campaigns/${second}/preview`, { token: a.token })).body).toMatchObject({ eligible: 0, excluded: { opted_out: 1 } });
  });

  it("the database itself refuses to mark an email as sent without consent or for a suppressed prospect", async () => {
    const a = await register("cmp-db");
    const k = await contact(a.token);
    const id = await approved(a.token);
    await launch(a.token, id);
    const attempt = (await owner.query("SELECT id FROM send_attempts WHERE campaign_id = $1", [id])).rows[0].id as string;
    await consent(a.token, k.contactId, "withdrawn", -1_000);
    const ctx = { organizationId: a.orgId, userId: a.userId, role: "org_admin" };
    const send = () => asRuntime(ctx, async (c) => c.query("UPDATE send_attempts SET state = 'sent', provider = 'x', provider_message_id = 'm1' WHERE id = $1", [attempt]).then(() => "NO ERROR", (e: Error) => e.message));
    expect(await send()).toMatch(/no consent/);
    await consent(a.token, k.contactId, "granted", -500);
    expect(await send()).toBe("NO ERROR");
    await api.call("POST", "/suppressions", { token: a.token, body: { kind: "domain", value: k.domain, reason: "baja" } });
    const second = await owner.query("SELECT 1 FROM send_attempts WHERE id = $1 AND state = 'queued'", [attempt]);
    expect(second.rowCount).toBe(1); // asRuntime always rolls back
    const again = await asRuntime(ctx, async (c) => c.query("UPDATE send_attempts SET state = 'sent', provider = 'x', provider_message_id = 'm1' WHERE id = $1", [attempt]).then(() => "NO ERROR", (e: Error) => e.message));
    expect(again).toMatch(/do-not-contact/);
    // a closed attempt can never change, and attempts cannot be queued for a campaign that is not running
    await owner.query("UPDATE send_attempts SET state = 'skipped', skip_reason = 'x' WHERE id = $1", [attempt]);
    await expect(owner.query("UPDATE send_attempts SET state = 'queued', skip_reason = NULL WHERE id = $1", [attempt])).rejects.toThrow(/closed attempt cannot change/);
    const draftId = (await draft(a.token)).id;
    await expect(owner.query("INSERT INTO send_attempts (organization_id, campaign_id, contact_id) VALUES ($1,$2,$3)", [a.orgId, draftId, k.contactId])).rejects.toThrow(/running campaign/);
  });
});

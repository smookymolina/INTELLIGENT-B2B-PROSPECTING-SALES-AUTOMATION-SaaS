import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MessageDraftDto, OutreachContextDto, type MembershipRole } from "@prospecting/contracts";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** P7-03: personalised drafts. Eligibility, approved evidence, grounded figures, immutability and human approval; nothing here sends. */
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
const consent = (t: string, cid: string, event: "granted" | "withdrawn", offset = -30_000) =>
  api.call("POST", `/contacts/${cid}/consent`, { token: t, body: { event, evidence: `Registro manual ${event}`, occurredAt: iso(offset) } });

async function contact(t: string, opts: { consent?: boolean; name?: string } = {}) {
  const domain = `drf-${randomUUID().slice(0, 8)}.example`;
  const p = (await api.call("POST", "/prospects", { token: t, body: { name: opts.name ?? `Co ${randomUUID().slice(0, 5)}`, domain } })).body as { id: string };
  const c = (await api.call("POST", `/prospects/${p.id}/contacts`, { token: t, body: { address: `compras@${domain}`, displayName: "Compras", source: "Formulario web, 2026-09-01" } })).body as { id: string };
  if (opts.consent !== false) expect((await consent(t, c.id, "granted", -60_000)).status).toBe(201);
  return { prospectId: p.id, contactId: c.id };
}
/** WhatsApp contacts have no public endpoint yet; seed one straight into the database with a granted consent. */
async function whatsappContact(a: Account, granted = true) {
  const p = (await api.call("POST", "/prospects", { token: a.token, body: { name: `Wa ${randomUUID().slice(0, 5)}`, domain: `wa-${randomUUID().slice(0, 8)}.example` } })).body as { id: string };
  const cid = randomUUID();
  await owner.query(
    "INSERT INTO contacts (id, organization_id, prospect_id, channel, address, address_key, source, created_by, updated_at) VALUES ($1,$2,$3,'whatsapp','+5215512345678','+5215512345678','Alta manual',$4, now())",
    [cid, a.orgId, p.id, a.userId],
  );
  if (granted) {
    await owner.query("INSERT INTO consent_events (organization_id, contact_id, event, evidence, occurred_at, recorded_by) VALUES ($1,$2,'granted','Opt-in WhatsApp en formulario', now() - interval '1 day', $3)", [a.orgId, cid, a.userId]);
  }
  return cid;
}
async function approvedItem(t: string, body: Record<string, unknown> = {}) {
  const res = await api.call("POST", "/catalog/items", { token: t, body: { kind: "product", sku: `DR-${randomUUID().slice(0, 8)}`, name: "Widget Pro", description: "Garantia de 24 meses", ...body } });
  await api.call("POST", `/catalog/items/${res.body.id}/approve`, { token: t });
  return { id: res.body.id as string, ref: `item:${res.body.id}:v1` };
}
const create = (t: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => api.call("POST", "/message-drafts", { token: t, body, headers });
const emailBody = (cid: string, over: Record<string, unknown> = {}) => ({ contactId: cid, channel: "email", subject: "Una idea para su equipo", body: "Hola, le comparto una propuesta breve.", evidenceRefs: [], ...over });

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("outreach context", () => {
  it("returns eligibility per channel, a masked contact, approved evidence only and the limits; and audits the read", async () => {
    const a = await register("ctx");
    const k = await contact(a.token, { name: "Acme Foods" });
    const ok = await approvedItem(a.token);
    await api.call("POST", "/catalog/items", { token: a.token, body: { kind: "product", sku: `DR-${randomUUID().slice(0, 8)}`, name: "SECRET DRAFT ITEM" } });
    const res = await api.call("GET", `/contacts/${k.contactId}/outreach-context`, { token: a.token });
    expect(res.status).toBe(200);
    expect(OutreachContextDto.safeParse(res.body).success).toBe(true);
    expect(res.body.channels.email).toEqual({ eligible: true, reasons: [] });
    expect(res.body.channels.whatsapp).toEqual({ eligible: false, reasons: ["channel_mismatch"] });
    expect(res.body.contact.addressMasked).toMatch(/^c\*\*\*@drf-/);
    expect(JSON.stringify(res.body)).not.toContain("compras@");
    expect(res.body.prospect.name).toBe("Acme Foods");
    expect(res.body.evidence.map((e: { ref: string }) => e.ref)).toContain(ok.ref);
    expect(JSON.stringify(res.body)).not.toContain("SECRET DRAFT ITEM");
    expect(res.body.constraints.whatsapp).toMatchObject({ bodyMax: 1024, templateOnly: true });
    const audit = await owner.query("SELECT 1 FROM audit_events WHERE organization_id=$1 AND action='draft.context_read' AND resource_id=$2", [a.orgId, k.contactId]);
    expect(audit.rowCount).toBe(1);
  });

  it("shows why a contact is not eligible and answers 404 for a foreign or unknown contact", async () => {
    const a = await register("ctx2");
    const b = await register("ctx3");
    const k = await contact(a.token, { consent: false });
    expect((await api.call("GET", `/contacts/${k.contactId}/outreach-context`, { token: a.token })).body.channels.email).toEqual({ eligible: false, reasons: ["no_consent"] });
    expect((await api.call("GET", `/contacts/${k.contactId}/outreach-context`, { token: b.token })).status).toBe(404);
    expect((await api.call("GET", `/contacts/${randomUUID()}/outreach-context`, { token: a.token })).status).toBe(404);
    expect((await api.call("GET", "/contacts/not-a-uuid/outreach-context", { token: a.token })).status).toBe(400);
    expect((await api.call("GET", `/contacts/${k.contactId}/outreach-context`)).status).toBe(401);
  });
});

describe("creating drafts", () => {
  it("creates an email draft pending review, with provenance from X-Client-Kind (which authorises nothing)", async () => {
    const a = await register("mk");
    const k = await contact(a.token);
    const ev = await approvedItem(a.token);
    const human = await create(a.token, emailBody(k.contactId, { evidenceRefs: [ev.ref], body: "Incluye garantia de 24 meses." }));
    expect(human.status).toBe(201);
    expect(MessageDraftDto.safeParse(human.body).success).toBe(true);
    expect(human.body).toMatchObject({ status: "pending_review", authorKind: "human", createdBy: a.userId, decidedBy: null, evidenceRefs: [ev.ref] });
    const mcp = await create(a.token, emailBody(k.contactId), { "x-client-kind": "mcp" });
    expect(mcp.body.authorKind).toBe("mcp");
    expect(mcp.body.status).toBe("pending_review");
    // the header does not grant approval
    const seller = await member(a.orgId, "seller");
    expect((await create(seller, emailBody(k.contactId), { "x-client-kind": "mcp" })).status).toBe(403);
    expect((await api.call("GET", `/message-drafts/${human.body.id}`, { token: a.token })).body.id).toBe(human.body.id);
    const list = await api.call("GET", `/message-drafts?status=pending_review&contactId=${k.contactId}`, { token: a.token });
    expect(list.body.items).toHaveLength(2);
  });

  it("creates a WhatsApp template draft for a WhatsApp contact with consent, and refuses subjects and long bodies", async () => {
    const a = await register("wa");
    const cid = await whatsappContact(a);
    const ctx = await api.call("GET", `/contacts/${cid}/outreach-context`, { token: a.token });
    expect(ctx.body.channels.whatsapp.eligible).toBe(true);
    expect(ctx.body.channels.email).toEqual({ eligible: false, reasons: ["channel_mismatch"] });
    const res = await create(a.token, { contactId: cid, channel: "whatsapp", body: "Hola, le escribimos de parte de Acme.", evidenceRefs: [] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ channel: "whatsapp", subject: null });
    expect((await create(a.token, { contactId: cid, channel: "whatsapp", subject: "no", body: "x", evidenceRefs: [] })).status).toBe(400);
    expect((await create(a.token, { contactId: cid, channel: "whatsapp", body: "a".repeat(1025), evidenceRefs: [] })).status).toBe(400);
    expect((await create(a.token, { contactId: cid, channel: "whatsapp", body: "a".repeat(1024), evidenceRefs: [] })).status).toBe(201);
    // an email draft for a WhatsApp-only contact is refused
    expect((await create(a.token, emailBody(cid))).status).toBe(409);
  });

  it("validates the input (400) and never answers 500", async () => {
    const a = await register("val");
    const k = await contact(a.token);
    for (const bad of [
      emailBody(k.contactId, { subject: undefined }),
      emailBody(k.contactId, { subject: "a".repeat(201) }),
      emailBody(k.contactId, { body: "" }),
      emailBody(k.contactId, { body: "a".repeat(5001) }),
      emailBody(k.contactId, { body: "hola\u0000mundo" }),
      emailBody(k.contactId, { subject: "x\u0000" }),
      emailBody(k.contactId, { channel: "sms" }),
      emailBody(k.contactId, { contactId: "nope" }),
      emailBody(k.contactId, { evidenceRefs: "item:x" }),
      emailBody(k.contactId, { extra: 1 }),
    ]) {
      const r = await create(a.token, bad);
      expect(r.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    expect((await api.call("POST", "/message-drafts", { body: emailBody(k.contactId) })).status).toBe(401);
  });

  it("is isolated between tenants: 404 on a foreign contact and on a foreign draft", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    const k = await contact(a.token);
    expect((await create(b.token, emailBody(k.contactId))).status).toBe(404);
    const d = await create(a.token, emailBody(k.contactId));
    expect((await api.call("GET", `/message-drafts/${d.body.id}`, { token: b.token })).status).toBe(404);
    expect((await api.call("POST", `/message-drafts/${d.body.id}/approve`, { token: b.token })).status).toBe(404);
    expect((await api.call("POST", `/message-drafts/${d.body.id}/reject`, { token: b.token, body: { note: "x" } })).status).toBe(404);
    expect((await api.call("GET", "/message-drafts", { token: b.token })).body.items).toEqual([]);
  });

  it("refuses a contact without consent, with withdrawn consent, opted out, or at a suppressed prospect", async () => {
    const a = await register("elig");
    const none = await contact(a.token, { consent: false });
    const r1 = await create(a.token, emailBody(none.contactId));
    expect(r1.status).toBe(409);
    expect(r1.body.message).toContain("no_consent");

    const revoked = await contact(a.token);
    expect((await create(a.token, emailBody(revoked.contactId))).status).toBe(201);
    expect((await consent(a.token, revoked.contactId, "withdrawn")).status).toBe(201);
    expect((await create(a.token, emailBody(revoked.contactId))).status).toBe(409);

    const optedOut = await contact(a.token);
    await owner.query("UPDATE contacts SET status='opted_out' WHERE id=$1", [optedOut.contactId]);
    expect((await create(a.token, emailBody(optedOut.contactId))).status).toBe(409);

    const suppressed = await contact(a.token);
    await owner.query("UPDATE prospects SET status='disqualified' WHERE id=$1", [suppressed.prospectId]);
    const r4 = await create(a.token, emailBody(suppressed.contactId));
    expect(r4.status).toBe(409);
    expect(r4.body.message).toContain("suppressed");
    expect((await owner.query("SELECT 1 FROM message_drafts WHERE contact_id = ANY($1)", [[none.contactId, optedOut.contactId, suppressed.contactId]])).rowCount).toBe(0);
  });

  it("accepts only approved evidence of the same tenant, and only figures the evidence supports", async () => {
    const a = await register("evi");
    const b = await register("evi-b");
    const k = await contact(a.token);
    const ok = await approvedItem(a.token);
    const draftItem = await api.call("POST", "/catalog/items", { token: a.token, body: { kind: "product", sku: `DR-${randomUUID().slice(0, 8)}`, name: "Unapproved" } });
    const foreign = await approvedItem(b.token);
    for (const ref of [`item:${draftItem.body.id}:v1`, foreign.ref, "item:garbage", `item:${randomUUID()}:v1`]) {
      const r = await create(a.token, emailBody(k.contactId, { evidenceRefs: [ref] }));
      expect(r.status, ref).toBe(400);
    }
    const invented = await create(a.token, emailBody(k.contactId, { evidenceRefs: [ok.ref], body: "Le ofrecemos 35% de descuento y garantia de 24 meses." }));
    expect(invented.status).toBe(400);
    expect(invented.body.message).toContain("35");
    expect((await create(a.token, emailBody(k.contactId, { body: "Contamos con 500 clientes." }))).status).toBe(400);
    expect((await create(a.token, emailBody(k.contactId, { evidenceRefs: [ok.ref], body: "Garantia de 24 meses." }))).status).toBe(201);
  });
});

describe("deciding drafts", () => {
  it("approves and rejects once, only from pending_review, by a role with campaigns:approve; the database stamps the decision", async () => {
    const a = await register("dec");
    const k = await contact(a.token);
    const manager = await member(a.orgId, "campaign_manager");
    const viewer = await member(a.orgId, "viewer");
    const d = (await create(manager, emailBody(k.contactId))).body.id as string;
    expect((await api.call("POST", `/message-drafts/${d}/approve`, { token: manager })).status).toBe(403);
    expect((await api.call("POST", `/message-drafts/${d}/approve`, { token: viewer })).status).toBe(403);
    const ap = await api.call("POST", `/message-drafts/${d}/approve`, { token: a.token });
    expect(ap.status).toBe(200);
    expect(ap.body).toMatchObject({ status: "approved", decidedBy: a.userId });
    expect(ap.body.decidedAt).toBeTruthy();
    expect((await api.call("POST", `/message-drafts/${d}/approve`, { token: a.token })).status).toBe(409);
    expect((await api.call("POST", `/message-drafts/${d}/reject`, { token: a.token, body: { note: "tarde" } })).status).toBe(409);

    const d2 = (await create(a.token, emailBody(k.contactId))).body.id as string;
    expect((await api.call("POST", `/message-drafts/${d2}/reject`, { token: a.token, body: {} })).status).toBe(400);
    expect((await api.call("POST", `/message-drafts/${d2}/reject`, { token: a.token, body: { note: "n\u0000" } })).status).toBe(400);
    const rj = await api.call("POST", `/message-drafts/${d2}/reject`, { token: a.token, body: { note: "Tono demasiado agresivo" } });
    expect(rj.status).toBe(200);
    expect(rj.body).toMatchObject({ status: "rejected", decisionNote: "Tono demasiado agresivo", decidedBy: a.userId });
    expect((await api.call("POST", `/message-drafts/${d2}/approve`, { token: a.token })).status).toBe(409);
    expect((await api.call("POST", `/message-drafts/${randomUUID()}/approve`, { token: a.token })).status).toBe(404);
  });

  it("re-checks eligibility when approving: a consent withdrawn after creation blocks the approval", async () => {
    const a = await register("recheck");
    const k = await contact(a.token);
    const d = (await create(a.token, emailBody(k.contactId))).body.id as string;
    expect((await consent(a.token, k.contactId, "withdrawn")).status).toBe(201);
    const r = await api.call("POST", `/message-drafts/${d}/approve`, { token: a.token });
    expect(r.status).toBe(409);
    expect((await api.call("GET", `/message-drafts/${d}`, { token: a.token })).body.status).toBe("pending_review");
    // rejecting stays possible
    expect((await api.call("POST", `/message-drafts/${d}/reject`, { token: a.token, body: { note: "sin consentimiento" } })).status).toBe(200);
  });

  it("paginates by cursor and filters by status", async () => {
    const a = await register("page");
    const k = await contact(a.token);
    for (let i = 0; i < 3; i++) await create(a.token, emailBody(k.contactId));
    const p1 = await api.call("GET", "/message-drafts?limit=2", { token: a.token });
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await api.call("GET", `/message-drafts?limit=2&cursor=${p1.body.nextCursor}`, { token: a.token });
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
    expect((await api.call("GET", "/message-drafts?status=approved", { token: a.token })).body.items).toEqual([]);
    expect((await api.call("GET", "/message-drafts?status=bogus", { token: a.token })).status).toBe(400);
    expect((await api.call("GET", "/message-drafts?limit=0", { token: a.token })).status).toBe(400);
  });
});

describe("invariants in the database", () => {
  it("content is immutable, transitions are one-way, rows are never deleted, and only an approver role can decide", async () => {
    const a = await register("sql");
    const k = await contact(a.token);
    const id = (await create(a.token, emailBody(k.contactId))).body.id as string;
    await expect(owner.query("UPDATE message_drafts SET body='otro' WHERE id=$1", [id])).rejects.toThrow(/immutable/);
    await expect(owner.query("UPDATE message_drafts SET evidence_refs=ARRAY['x'] WHERE id=$1", [id])).rejects.toThrow(/immutable/);
    await expect(owner.query("UPDATE message_drafts SET author_kind='mcp' WHERE id=$1", [id])).rejects.toThrow(/immutable/);
    await expect(owner.query("UPDATE message_drafts SET decided_by=$2 WHERE id=$1", [id, a.userId])).rejects.toThrow(/set by the database/);
    await expect(owner.query("UPDATE message_drafts SET status='pending_review' WHERE id=$1", [id])).resolves.toBeDefined();
    await expect(owner.query("DELETE FROM message_drafts WHERE id=$1", [id])).rejects.toThrow(/never deleted/);
    await expect(owner.query("INSERT INTO message_drafts (organization_id, contact_id, channel, subject, body, status, created_by) VALUES ($1,$2,'email','s','b','approved',$3)", [a.orgId, k.contactId, a.userId])).rejects.toThrow(/starts pending/);
    await expect(owner.query("INSERT INTO message_drafts (organization_id, contact_id, channel, subject, body, created_by) VALUES ($1,$2,'whatsapp','s','b',$3)", [a.orgId, k.contactId, a.userId])).rejects.toThrow(/subject_rule/);

    // as the runtime role: a campaign_manager cannot decide (RLS hides the row from UPDATE), an org_admin can and is stamped
    const none = await asRuntime({ organizationId: a.orgId, userId: a.userId, role: "campaign_manager" }, (c) => c.query("UPDATE message_drafts SET status='approved' WHERE id=$1", [id]));
    expect(none.rowCount).toBe(0);
    await asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, async (c) => {
      await expect(c.query("UPDATE message_drafts SET body='x' WHERE id=$1", [id])).rejects.toThrow(/permission denied/);
    });
    await asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, async (c) => {
      const r = await c.query("UPDATE message_drafts SET status='approved' WHERE id=$1 RETURNING decided_by, decided_at", [id]);
      expect(r.rows[0].decided_by).toBe(a.userId);
      expect(r.rows[0].decided_at).toBeTruthy();
    });
    // approved -> rejected is refused whoever asks
    expect((await api.call("POST", `/message-drafts/${id}/approve`, { token: a.token })).status).toBe(200);
    await expect(owner.query("UPDATE message_drafts SET status='rejected', decision_note='n' WHERE id=$1", [id])).rejects.toThrow(/invalid draft transition/);
  });

  it("row-level security: another organization sees nothing and cannot insert", async () => {
    const a = await register("rls-a");
    const b = await register("rls-b");
    const k = await contact(a.token);
    const id = (await create(a.token, emailBody(k.contactId))).body.id as string;
    await asRuntime({ organizationId: b.orgId, userId: b.userId, role: "org_admin" }, async (c) => {
      expect((await c.query("SELECT 1 FROM message_drafts WHERE id=$1", [id])).rowCount).toBe(0);
      await expect(c.query("INSERT INTO message_drafts (organization_id, contact_id, channel, subject, body, created_by) VALUES ($1,$2,'email','s','b',$3)", [a.orgId, k.contactId, b.userId])).rejects.toThrow(/row-level security/);
    });
  });
});

describe("WhatsApp contacts through the API", () => {
  it("creates a WhatsApp contact, records consent per contact, becomes eligible and takes a draft; email stays separate", async () => {
    const a = await register("wac");
    const p = (await api.call("POST", "/prospects", { token: a.token, body: { name: "Wa Co", domain: `wac-${randomUUID().slice(0, 8)}.example` } })).body as { id: string };
    for (const bad of ["5512345678", "+0123456789", "+52 55 1234 5678", "+12", "x@y.com"]) {
      expect((await api.call("POST", `/prospects/${p.id}/contacts`, { token: a.token, body: { channel: "whatsapp", address: bad, source: "Alta manual" } })).status, bad).toBe(400);
    }
    expect((await api.call("POST", `/prospects/${p.id}/contacts`, { token: a.token, body: { channel: "email", address: "+5215512345678", source: "Alta manual" } })).status).toBe(400);
    expect((await api.call("POST", `/prospects/${p.id}/contacts`, { token: a.token, body: { channel: "sms", address: "+5215512345678", source: "Alta manual" } })).status).toBe(400);
    const c = await api.call("POST", `/prospects/${p.id}/contacts`, { token: a.token, body: { channel: "whatsapp", address: "+5215512345678", displayName: "Ana", source: "Alta manual" } });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ channel: "whatsapp", consent: "none" });
    expect((await api.call("POST", `/prospects/${p.id}/contacts`, { token: a.token, body: { channel: "whatsapp", address: "+5215512345678", source: "Alta manual" } })).status).toBe(409);
    expect((await create(a.token, { contactId: c.body.id, channel: "whatsapp", body: "Hola", evidenceRefs: [] })).status).toBe(409);
    expect((await api.call("GET", `/contacts/${c.body.id}/outreach-context`, { token: a.token })).body.channels.whatsapp).toEqual({ eligible: false, reasons: ["no_consent"] });
    expect((await consent(a.token, c.body.id, "granted", -60_000)).status).toBe(201);
    const ctx = await api.call("GET", `/contacts/${c.body.id}/outreach-context`, { token: a.token });
    expect(ctx.body.channels.whatsapp.eligible).toBe(true);
    expect(ctx.body.channels.email.reasons).toEqual(["channel_mismatch"]);
    expect((await create(a.token, { contactId: c.body.id, channel: "whatsapp", body: "Hola Ana", evidenceRefs: [] })).status).toBe(201);
    // the same prospect can also have an email contact; each has its own consent
    const e = await api.call("POST", `/prospects/${p.id}/contacts`, { token: a.token, body: { address: "Ventas@Wac.Example", source: "Formulario" } });
    expect(e.body).toMatchObject({ channel: "email", address: "ventas@wac.example", consent: "none" });
    expect((await api.call("GET", `/prospects/${p.id}/contacts`, { token: a.token })).body.items).toHaveLength(2);
  });
});

describe("erasing a contact redacts its drafts", () => {
  it("replaces personal content, keeps id/state/channel/dates and the rest of the history, and direct updates stay refused", async () => {
    const a = await register("erd");
    const k = await contact(a.token, { name: "Erase Co" });
    const d1 = (await create(a.token, emailBody(k.contactId, { subject: "Hola Juan Perez", body: "Juan, le llamaremos a su telefono" }))).body.id as string;
    const d2 = (await create(a.token, emailBody(k.contactId, { body: "Otro mensaje con datos" }))).body.id as string;
    expect((await api.call("POST", `/message-drafts/${d2}/reject`, { token: a.token, body: { note: "Mencionaba a Juan Perez" } })).status).toBe(200);
    const other = await contact(a.token);
    const keep = (await create(a.token, emailBody(other.contactId, { body: "Mensaje de otro contacto" }))).body.id as string;
    const before = (await api.call("GET", `/message-drafts/${d2}`, { token: a.token })).body;

    const r = (await api.call("POST", "/privacy/requests", { token: a.token, body: { contactId: k.contactId, kind: "erase" } })).body;
    expect((await api.call("POST", `/privacy/requests/${r.id}/complete`, { token: a.token })).status).toBe(200);

    const x1 = (await api.call("GET", `/message-drafts/${d1}`, { token: a.token })).body;
    expect(x1).toMatchObject({ subject: "[redacted]", body: "[redacted]", evidenceRefs: [], status: "pending_review", channel: "email", contactId: k.contactId });
    const x2 = (await api.call("GET", `/message-drafts/${d2}`, { token: a.token })).body;
    expect(x2).toMatchObject({ body: "[redacted]", decisionNote: "[redacted]", status: "rejected", decidedAt: before.decidedAt, createdAt: before.createdAt });
    expect((await api.call("GET", `/message-drafts/${keep}`, { token: a.token })).body.body).toBe("Mensaje de otro contacto");
    expect((await api.call("GET", `/message-drafts?contactId=${k.contactId}`, { token: a.token })).body.items).toHaveLength(2);
    await expect(owner.query("UPDATE message_drafts SET body='nuevo' WHERE id=$1", [d1])).rejects.toThrow(/immutable/);
    await asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, async (c) => {
      await expect(c.query("SELECT redact_contact_drafts($1)", [keep])).rejects.toThrow(/permission denied/);
    });
    await asRuntime({ organizationId: a.orgId, userId: a.userId, role: "org_admin" }, async (c) => {
      await expect(c.query("INSERT INTO draft_redaction_marks (xid) VALUES (txid_current())")).rejects.toThrow(/permission denied/);
    });
  });

  it("also erases a WhatsApp contact (placeholder address stays valid) and redacts its template drafts", async () => {
    const a = await register("erw");
    const p = (await api.call("POST", "/prospects", { token: a.token, body: { name: "Wa Erase", domain: `erw-${randomUUID().slice(0, 8)}.example` } })).body as { id: string };
    const c = (await api.call("POST", `/prospects/${p.id}/contacts`, { token: a.token, body: { channel: "whatsapp", address: "+5215599990000", source: "Alta manual" } })).body;
    await consent(a.token, c.id, "granted", -60_000);
    const d = (await create(a.token, { contactId: c.id, channel: "whatsapp", body: "Hola Maria", evidenceRefs: [] })).body.id as string;
    const r = (await api.call("POST", "/privacy/requests", { token: a.token, body: { contactId: c.id, kind: "erase" } })).body;
    expect((await api.call("POST", `/privacy/requests/${r.id}/complete`, { token: a.token })).status).toBe(200);
    expect((await api.call("GET", `/message-drafts/${d}`, { token: a.token })).body).toMatchObject({ body: "[redacted]", subject: null, channel: "whatsapp" });
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WhatsAppLinkDto } from "@prospecting/contracts";
import { type Api, owner, PASSWORD, startApi } from "./harness.js";

/** WhatsApp manual: solo enlace wa.me para que la persona envie desde su numero; nada se envia desde el sistema. */
let api: Api;
type Account = { token: string; orgId: string; userId: string };
async function register(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label}` } });
  const me = await api.call("GET", "/me", { token: res.body.token });
  return { token: res.body.token, orgId: res.body.organization.id, userId: me.body.user.id };
}
async function whatsappContact(a: Account, opts: { granted?: boolean; phone?: string } = {}) {
  const p = (await api.call("POST", "/prospects", { token: a.token, body: { name: `Wa ${randomUUID().slice(0, 5)}`, domain: `wa-${randomUUID().slice(0, 8)}.example` } })).body as { id: string };
  const cid = randomUUID();
  const phone = opts.phone ?? `+52155${Math.floor(1e7 + Math.random() * 9e7)}`;
  await owner.query(
    "INSERT INTO contacts (id, organization_id, prospect_id, channel, address, address_key, source, created_by, updated_at) VALUES ($1,$2,$3,'whatsapp',$4,$4,'Alta manual',$5, now())",
    [cid, a.orgId, p.id, phone, a.userId],
  );
  if (opts.granted !== false) await owner.query("INSERT INTO consent_events (organization_id, contact_id, event, evidence, occurred_at, recorded_by) VALUES ($1,$2,'granted','Opt-in WhatsApp en formulario', now() - interval '1 day', $3)", [a.orgId, cid, a.userId]);
  return { cid, prospectId: p.id, phone };
}
async function draft(a: Account, cid: string, body = "Hola, le escribimos de parte de Acme & Co. ¿Hablamos?", approve = true) {
  const d = await api.call("POST", "/message-drafts", { token: a.token, body: { contactId: cid, channel: "whatsapp", body, evidenceRefs: [] } });
  expect(d.status).toBe(201);
  if (approve) expect((await api.call("POST", `/message-drafts/${d.body.id}/approve`, { token: a.token })).status).toBe(200);
  return d.body.id as string;
}
const link = (a: Account, id: string) => api.call("POST", `/drafts/${id}/whatsapp-link`, { token: a.token });
const sent = (a: Account, id: string) => api.call("POST", `/drafts/${id}/mark-sent-manual`, { token: a.token });

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("whatsapp manual", () => {
  it("no genera enlace sin aprobacion", async () => {
    const a = await register("wm1");
    const { cid } = await whatsappContact(a);
    const id = await draft(a, cid, "Hola", false);
    expect((await link(a, id)).status).toBe(409);
    expect((await sent(a, id)).status).toBe(409);
  });

  it("genera el enlace codificado solo con el cuerpo del borrador, sin marcar enviado", async () => {
    const a = await register("wm2");
    const { cid, phone } = await whatsappContact(a);
    const cidPhone = phone.slice(1);
    await whatsappContact(a, { phone: "+5215599998888" }); // otro prospecto: no debe aparecer
    const id = await draft(a, cid);
    const res = await link(a, id);
    expect(res.status).toBe(200);
    expect(WhatsAppLinkDto.safeParse(res.body).success).toBe(true);
    expect(res.body.url).toBe(`https://wa.me/${cidPhone}?text=${encodeURIComponent("Hola, le escribimos de parte de Acme & Co. ¿Hablamos?")}`);
    expect(res.body.url).not.toContain("5599998888");
    expect(res.body.url).not.toContain(" ");
    expect((await api.call("GET", `/drafts/${id}/whatsapp-status`, { token: a.token })).body.state).toBe("link_opened");
    expect((await owner.query("SELECT 1 FROM whatsapp_manual_events WHERE draft_id=$1 AND kind='sent'", [id])).rows).toHaveLength(0);
  });

  it("revalida consentimiento y supresion al pedir el enlace", async () => {
    const a = await register("wm3");
    const c1 = await whatsappContact(a);
    const id1 = await draft(a, c1.cid);
    await owner.query("INSERT INTO consent_events (organization_id, contact_id, event, evidence, occurred_at, recorded_by) VALUES ($1,$2,'withdrawn','Retiro por chat', now(), $3)", [a.orgId, c1.cid, a.userId]);
    const r1 = await link(a, id1);
    expect(r1.status).toBe(409);
    expect(r1.body.message).toMatch(/no_consent|opted_out/);
    const c2 = await whatsappContact(a);
    const id2 = await draft(a, c2.cid);
    await owner.query("UPDATE prospects SET status='disqualified' WHERE id=$1", [c2.prospectId]);
    const r2 = await link(a, id2);
    expect(r2.status).toBe(409);
    expect(r2.body.message).toContain("suppressed");
  });

  it("aplica el tope por usuario y hora", async () => {
    const a = await register("wm4");
    const before = process.env.WHATSAPP_LINKS_PER_USER_HOUR;
    process.env.WHATSAPP_LINKS_PER_USER_HOUR = "2";
    try {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push(await draft(a, (await whatsappContact(a)).cid));
      expect((await link(a, ids[0] as string)).status).toBe(200);
      expect((await link(a, ids[1] as string)).status).toBe(200);
      expect((await link(a, ids[0] as string)).status).toBe(200); // el mismo borrador no cuenta dos veces
      expect((await link(a, ids[2] as string)).status).toBe(429);
    } finally {
      if (before === undefined) delete process.env.WHATSAPP_LINKS_PER_USER_HOUR;
      else process.env.WHATSAPP_LINKS_PER_USER_HOUR = before;
    }
  });

  it("marcar enviado exige abrir el enlace, es idempotente y queda auditado una vez", async () => {
    const a = await register("wm5");
    const { cid } = await whatsappContact(a);
    const id = await draft(a, cid);
    expect((await sent(a, id)).status).toBe(409);
    await link(a, id);
    const first = await sent(a, id);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ state: "sent_manual", alreadyRecorded: false });
    const second = await sent(a, id);
    expect(second.body).toMatchObject({ alreadyRecorded: true, sentAt: first.body.sentAt });
    expect((await owner.query("SELECT 1 FROM whatsapp_manual_events WHERE draft_id=$1 AND kind='sent'", [id])).rows).toHaveLength(1);
    expect((await owner.query("SELECT 1 FROM audit_events WHERE resource_id=$1 AND action='draft.whatsapp_sent_manual'", [id])).rows).toHaveLength(1);
    expect((await link(a, id)).status).toBe(409);
  });

  it("aislamiento entre organizaciones", async () => {
    const a = await register("wm6a");
    const b = await register("wm6b");
    const id = await draft(a, (await whatsappContact(a)).cid);
    await link(a, id);
    expect((await link(b, id)).status).toBe(404);
    expect((await sent(b, id)).status).toBe(404);
    expect((await api.call("GET", `/drafts/${id}/whatsapp-status`, { token: b.token })).status).toBe(404);
  });
});

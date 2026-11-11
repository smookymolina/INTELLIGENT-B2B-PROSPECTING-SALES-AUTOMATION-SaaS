import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_LABELS_ES, type MembershipRole } from "@prospecting/contracts";
import { type Api, asRuntime, PASSWORD, seedMember, startApi } from "./harness.js";

/** Visibilidad por propietario: Gerente (org_admin) ve todo y reasigna; Usuario (seller) solo lo que trajo. */
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
const prospect = async (t: string) => (await api.call("POST", "/prospects", { token: t, body: { name: `Co ${randomUUID().slice(0, 6)}`, domain: `own-${randomUUID().slice(0, 8)}.example` } })).body as { id: string; domain: string };
const lead = async (t: string, prospectId: string) => (await api.call("POST", `/prospects/${prospectId}/replies`, { token: t, body: { text: "Queremos comprar 10 unidades" } })).body.effects.leadId as string;
const ids = (r: { body: { items: Array<{ id: string }> } }) => r.body.items.map((i) => i.id);

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("owner visibility", () => {
  it("labels: org_admin is Gerente, seller is Usuario", () => {
    expect(ROLE_LABELS_ES.org_admin).toBe("Gerente");
    expect(ROLE_LABELS_ES.seller).toBe("Usuario");
  });

  it("a seller sees and touches only own prospects, leads, contacts and drafts; the manager sees everything; another org sees nothing", async () => {
    const mgr = await register("mgr");
    const s1 = await member(mgr.orgId, "seller", "s1");
    const s2 = await member(mgr.orgId, "seller", "s2");
    const other = await register("other");

    const p1 = await prospect(s1.token);
    const p2 = await prospect(s2.token);
    const pm = await prospect(mgr.token);

    // propietario = quien lo trajo
    expect(ids(await api.call("GET", "/prospects", { token: s1.token }))).toEqual([p1.id]);
    expect(ids(await api.call("GET", "/prospects", { token: s2.token }))).toEqual([p2.id]);
    expect(ids(await api.call("GET", "/prospects", { token: mgr.token })).sort()).toEqual([p1.id, p2.id, pm.id].sort());
    expect(ids(await api.call("GET", "/prospects", { token: other.token }))).toEqual([]);

    // id directo -> 404, lectura y escritura
    expect((await api.call("GET", `/prospects/${p2.id}`, { token: s1.token })).status).toBe(404);
    expect((await api.call("PATCH", `/prospects/${p2.id}`, { token: s1.token, body: { notes: "hack" } })).status).toBe(404);
    expect((await api.call("GET", `/prospects/${p1.id}`, { token: other.token })).status).toBe(404);
    expect((await api.call("PATCH", `/prospects/${p1.id}`, { token: s1.token, body: { notes: "mio" } })).status).toBe(200);

    // leads: el que trajo el prospecto lo conserva al volverse lead
    const l1 = await lead(s1.token, p1.id);
    const l2 = await lead(s2.token, p2.id);
    expect(ids(await api.call("GET", "/leads", { token: s1.token }))).toEqual([l1]);
    expect(ids(await api.call("GET", "/leads", { token: s2.token }))).toEqual([l2]);
    expect(ids(await api.call("GET", "/leads", { token: mgr.token })).sort()).toEqual([l1, l2].sort());
    expect((await api.call("GET", `/leads/${l2}`, { token: s1.token })).status).toBe(404);
    expect(ids(await api.call("GET", "/leads", { token: other.token }))).toEqual([]);

    // contactos y borradores heredan la visibilidad
    const c2 = (await api.call("POST", `/prospects/${p2.id}/contacts`, { token: s2.token, body: { address: `a@${p2.domain}`, displayName: "A", source: "Formulario web, 2026-09-01" } }));
    expect(c2.status).toBe(201);
    expect((await api.call("POST", `/prospects/${p2.id}/contacts`, { token: s1.token, body: { address: `b@${p2.domain}`, displayName: "B", source: "Formulario web, 2026-09-01" } })).status).toBe(404);
    const contactId = c2.body.id as string;
    await api.call("POST", `/contacts/${contactId}/consent`, { token: mgr.token, body: { event: "granted", evidence: "form", occurredAt: new Date(Date.now() - 60_000).toISOString() } });
    const d = await api.call("POST", "/message-drafts", { token: mgr.token, body: { contactId, channel: "email", subject: "Hola", body: "Cuerpo breve.", evidenceRefs: [] } });
    expect(d.status).toBe(201);
    // El rol seller no tiene API de borradores; el aislamiento se verifica a nivel RLS con el rol real.
    const seen = (u: string) => asRuntime({ organizationId: mgr.orgId, userId: u, role: "seller" }, async (c) => (await c.query("SELECT id FROM message_drafts WHERE id = $1", [d.body.id])).rowCount);
    expect(await seen(s2.userId)).toBe(1);
    expect(await seen(s1.userId)).toBe(0);
  });

  it("only the manager reassigns; the leads follow the prospect; the new owner sees it and the old one does not", async () => {
    const mgr = await register("mgr2");
    const s1 = await member(mgr.orgId, "seller", "s1");
    const s2 = await member(mgr.orgId, "seller", "s2");
    const outsider = await register("out");
    const p = await prospect(s1.token);
    const l = await lead(s1.token, p.id);

    expect((await api.call("PUT", `/prospects/${p.id}/owner`, { token: s1.token, body: { ownerUserId: s2.userId } })).status).toBe(403);
    expect((await api.call("PUT", `/leads/${l}/owner`, { token: s1.token, body: { ownerUserId: s2.userId } })).status).toBe(403);
    expect((await api.call("PUT", `/prospects/${p.id}/owner`, { token: mgr.token, body: { ownerUserId: outsider.userId } })).status).toBe(422);
    expect((await api.call("PUT", `/prospects/${p.id}/owner`, { token: outsider.token, body: { ownerUserId: outsider.userId } })).status).toBe(404);

    expect((await api.call("PUT", `/prospects/${p.id}/owner`, { token: mgr.token, body: { ownerUserId: s2.userId } })).body).toEqual({ id: p.id, ownerUserId: s2.userId });
    expect(ids(await api.call("GET", "/prospects", { token: s2.token }))).toEqual([p.id]);
    expect(ids(await api.call("GET", "/leads", { token: s2.token }))).toEqual([l]);
    expect(ids(await api.call("GET", "/prospects", { token: s1.token }))).toEqual([]);
    expect(ids(await api.call("GET", "/leads", { token: s1.token }))).toEqual([]);

    expect((await api.call("PUT", `/leads/${l}/owner`, { token: mgr.token, body: { ownerUserId: s1.userId } })).status).toBe(200);
    expect(ids(await api.call("GET", "/leads", { token: s1.token }))).toEqual([l]);
    expect(ids(await api.call("GET", "/leads", { token: s2.token }))).toEqual([]);
  });
});

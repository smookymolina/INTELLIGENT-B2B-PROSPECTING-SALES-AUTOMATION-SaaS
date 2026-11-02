import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// The real API is started in-process with the API test harness (needs a *_test database: TEST_DATABASE_URL).
import { type Api, PASSWORD, startApi } from "../../api/src/test/harness.js";

/** P7-04: the MCP server over stdio against the real API. Drafts only; no approve/send tool exists. */
let api: Api;
let apiBase: string;
type Account = { token: string; orgId: string };
const clients: Client[] = [];

const root = fileURLToPath(new URL("../../..", import.meta.url));
const tsx = `${root}node_modules/tsx/dist/cli.mjs`;
const entry = fileURLToPath(new URL("./server.ts", import.meta.url));

async function connect(token: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsx, entry],
    env: { MCP_API_URL: `${apiBase}/v1`, MCP_API_TOKEN: token },
    stderr: "ignore",
  });
  const client = new Client({ name: "int-test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}
type ToolRes = { isError?: boolean; content: { type: string; text: string }[] };
async function call(c: Client, name: string, args: Record<string, unknown>) {
  const res = (await c.callTool({ name, arguments: args })) as ToolRes;
  const text = res.content[0]?.text ?? "";
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: res.isError === true, text, json };
}

async function register(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label}` } });
  return { token: res.body.token, orgId: res.body.organization.id };
}
const iso = (offsetMs = -60_000) => new Date(Date.now() + offsetMs).toISOString();
async function emailContact(t: string, consent = true) {
  const domain = `mcp-${randomUUID().slice(0, 8)}.example`;
  const p = (await api.call("POST", "/prospects", { token: t, body: { name: `Co ${randomUUID().slice(0, 5)}`, domain } })).body as { id: string };
  const c = (await api.call("POST", `/prospects/${p.id}/contacts`, { token: t, body: { address: `compras@${domain}`, displayName: "Compras", source: "Formulario web, 2026-09-01" } })).body as { id: string };
  if (consent) {
    const r = await api.call("POST", `/contacts/${c.id}/consent`, { token: t, body: { event: "granted", evidence: "Registro manual granted", occurredAt: iso() } });
    expect(r.status).toBe(201);
  }
  return { prospectId: p.id, contactId: c.id, domain };
}
async function approvedItem(t: string) {
  const res = await api.call("POST", "/catalog/items", { token: t, body: { kind: "product", sku: `MC-${randomUUID().slice(0, 8)}`, name: "Widget Pro", description: "Garantia de 24 meses" } });
  await api.call("POST", `/catalog/items/${res.body.id}/approve`, { token: t });
  return `item:${res.body.id}:v1`;
}
const draftArgs = (contactId: string, over: Record<string, unknown> = {}) => ({ contactId, channel: "email", subject: "Una idea para su equipo", body: "Hola, le comparto una propuesta breve.", evidenceRefs: [], ...over });
const draftsCount = async (t: string, contactId: string) => (await api.call("GET", `/message-drafts?contactId=${contactId}`, { token: t })).body.items.length as number;

let a: Account;
beforeAll(async () => {
  api = await startApi();
  apiBase = api.app.getUrl ? await api.app.getUrl() : "";
  a = await register("mcp-a");
}, 60_000);
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  await api.close();
});

describe("MCP server over stdio", () => {
  it("exposes exactly the three tools", async () => {
    const c = await connect(a.token);
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_draft_status", "get_outreach_context", "save_message_draft"]);
  }, 30_000);

  it("reads an eligible context, saves a pending_review draft authored by mcp and reads its status", async () => {
    const c = await connect(a.token);
    const k = await emailContact(a.token);
    const ref = await approvedItem(a.token);
    const ctx = await call(c, "get_outreach_context", { contactId: k.contactId });
    expect(ctx.isError).toBe(false);
    expect(ctx.json.context.channels.email).toEqual({ eligible: true, reasons: [] });
    expect(ctx.json.context.evidence.map((e: { ref: string }) => e.ref)).toContain(ref);
    expect(ctx.text).not.toContain("compras@");
    expect(ctx.json.reminders.join(" ")).toMatch(/nothing is sent/);

    const saved = await call(c, "save_message_draft", draftArgs(k.contactId, { body: "Incluye garantia de 24 meses.", evidenceRefs: [ref] }));
    expect(saved.isError).toBe(false);
    expect(saved.json.draft).toMatchObject({ status: "pending_review", authorKind: "mcp", channel: "email", contactId: k.contactId });
    expect(saved.json.reminders.join(" ")).toMatch(/pending human approval/);

    const status = await call(c, "get_draft_status", { draftId: saved.json.draft.id });
    expect(status.isError).toBe(false);
    expect(status.json.draft).toMatchObject({ id: saved.json.draft.id, status: "pending_review" });
  }, 60_000);

  it("returns isError and creates nothing for a contact without consent", async () => {
    const c = await connect(a.token);
    const k = await emailContact(a.token, false);
    const r = await call(c, "save_message_draft", draftArgs(k.contactId));
    expect(r.isError).toBe(true);
    expect(await draftsCount(a.token, k.contactId)).toBe(0);
  }, 60_000);

  it("returns isError and creates nothing for a suppressed contact", async () => {
    const c = await connect(a.token);
    const k = await emailContact(a.token);
    const sup = await api.call("POST", "/suppressions", { token: a.token, body: { kind: "domain", value: k.domain, reason: "Solicitud del titular" } });
    expect(sup.status).toBe(201);
    const r = await call(c, "save_message_draft", draftArgs(k.contactId));
    expect(r.isError).toBe(true);
    expect(await draftsCount(a.token, k.contactId)).toBe(0);
  }, 60_000);

  it("fails with isError and does not leak the token when the token is invalid", async () => {
    const bad = `bad-token-${randomUUID()}`;
    const c = await connect(bad);
    const k = await emailContact(a.token);
    for (const [tool, args] of [
      ["get_outreach_context", { contactId: k.contactId }],
      ["save_message_draft", draftArgs(k.contactId)],
      ["get_draft_status", { draftId: randomUUID() }],
    ] as const) {
      const r = await call(c, tool, { ...args });
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain(bad);
    }
    expect(await draftsCount(a.token, k.contactId)).toBe(0);
  }, 60_000);

  it("treats another organisation's contact and draft as not found", async () => {
    const b = await register("mcp-b");
    const cb = await connect(b.token);
    const ca = await connect(a.token);
    const k = await emailContact(a.token);
    const saved = await call(ca, "save_message_draft", draftArgs(k.contactId));
    expect(saved.isError).toBe(false);
    expect((await call(cb, "get_outreach_context", { contactId: k.contactId })).isError).toBe(true);
    expect((await call(cb, "save_message_draft", draftArgs(k.contactId))).isError).toBe(true);
    expect((await call(cb, "get_draft_status", { draftId: saved.json.draft.id })).isError).toBe(true);
    expect(await draftsCount(a.token, k.contactId)).toBe(1);
  }, 60_000);

  it("rejects invalid input as isError and offers no way to approve, reject or send", async () => {
    const c = await connect(a.token);
    const k = await emailContact(a.token);
    const saved = await call(c, "save_message_draft", draftArgs(k.contactId));
    const id = saved.json.draft.id as string;
    expect((await call(c, "get_draft_status", { draftId: "not-a-uuid" })).isError).toBe(true);
    for (const name of ["approve_message_draft", "reject_message_draft", "send_message", "send_draft"]) {
      let failed = false;
      try {
        failed = (await call(c, name, { draftId: id })).isError;
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    }
    expect((await api.call("GET", `/message-drafts/${id}`, { token: a.token })).body).toMatchObject({ status: "pending_review", decidedBy: null });
  }, 60_000);
});

describe("MCP WhatsApp drafts", () => {
  it("drafts a WhatsApp message through MCP for a consented E.164 contact", async () => {
    const p = (await api.call("POST", "/prospects", { token: a.token, body: { name: `Wa ${randomUUID().slice(0, 5)}`, domain: `wa-${randomUUID().slice(0, 8)}.example` } })).body as { id: string };
    const created = await api.call("POST", `/prospects/${p.id}/contacts`, { token: a.token, body: { channel: "whatsapp", address: "+5215512345678", displayName: "Compras", source: "Alta manual" } });
    expect(created.status).toBe(201);
    const cid = created.body.id as string;
    await api.call("POST", `/contacts/${cid}/consent`, { token: a.token, body: { event: "granted", evidence: "Opt-in WhatsApp", occurredAt: iso() } });
    const c = await connect(a.token);
    const r = await call(c, "save_message_draft", { contactId: cid, channel: "whatsapp", body: "Hola, le compartimos una propuesta.", evidenceRefs: [] });
    expect(r.isError).toBe(false);
    expect(r.json.draft).toMatchObject({ channel: "whatsapp", status: "pending_review", authorKind: "mcp" });
    expect(r.json.reminders.join(" ")).toMatch(/template only/);
  }, 60_000);
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvidenceDto, MEMBERSHIP_ROLES, ResolveRefsDto, type MembershipRole } from "@prospecting/contracts";
import { type Api, PASSWORD, seedMember, startApi } from "./harness.js";

/** P3-06: evidence contract - only approved facts, citable refs, explicit no_evidence, citation checking, tenant isolation. */
let api: Api;
type Account = { token: string; orgId: string };

async function register(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label}` } });
  return { token: res.body.token, orgId: res.body.organization.id };
}
const sku = () => `EV-${randomUUID().slice(0, 8)}`;
async function newItem(t: string, body: Record<string, unknown> = {}, approve = true) {
  const res = await api.call("POST", "/catalog/items", { token: t, body: { kind: "product", sku: sku(), name: "Widget", ...body } });
  if (approve) await api.call("POST", `/catalog/items/${res.body.id}/approve`, { token: t });
  return { id: res.body.id as string, sku: res.body.sku as string };
}
const evidence = async (t: string, s: string, priceListId?: string) => {
  const res = await api.call("GET", `/catalog/evidence?sku=${encodeURIComponent(s)}${priceListId ? `&priceListId=${priceListId}` : ""}`, { token: t });
  expect(res.status).toBe(200);
  expect(EvidenceDto.safeParse(res.body).success).toBe(true); // the response always honours the published contract
  return res.body;
};
const resolve = async (t: string, refs: string[]) => {
  const res = await api.call("POST", "/catalog/evidence/resolve", { token: t, body: { refs } });
  expect(res.status).toBe(200);
  expect(ResolveRefsDto.safeParse(res.body).success).toBe(true);
  return res.body.results as Array<{ ref: string; status: string; reason?: string; currentRef?: string; evidence?: Record<string, unknown> }>;
};
async function approvedList(t: string, items: Array<{ id: string }>, price = "99.5", extra: Record<string, unknown> = {}) {
  const list = (await api.call("POST", "/catalog/price-lists", { token: t, body: { name: `L-${randomUUID().slice(0, 6)}`, currency: "MXN", ...extra } })).body.id as string;
  for (const it of items) await api.call("PUT", `/catalog/price-lists/${list}/entries/${it.id}`, { token: t, body: { unitPrice: price } });
  await api.call("POST", `/catalog/price-lists/${list}/approve`, { token: t });
  return list;
}

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("lookup: nothing is guessed", () => {
  it("an unknown SKU is no_evidence, and no price section appears unless a list was asked for", async () => {
    const a = await register("none");
    const res = await evidence(a.token, "DOES-NOT-EXIST");
    expect(res).toEqual({ sku: "DOES-NOT-EXIST", item: { status: "no_evidence", reason: "item_not_found" } });
  });

  it("drafts are never evidence and their content is never exposed", async () => {
    const a = await register("draft");
    const it1 = await newItem(a.token, { name: "SECRET DRAFT NAME" }, false);
    const res = await evidence(a.token, it1.sku);
    expect(res.item).toEqual({ status: "no_evidence", reason: "item_not_approved" });
    expect(JSON.stringify(res)).not.toContain("SECRET DRAFT NAME");
  });

  it("approved items yield citable evidence; open drafts and later versions behave as specified", async () => {
    const a = await register("approved");
    const cat = (await api.call("POST", "/catalog/categories", { token: a.token, body: { name: "Hardware" } })).body.id;
    const it1 = await newItem(a.token, { name: "Widget", description: "d", unit: "pcs", categoryId: cat, features: [{ name: "Color", value: "Red" }] });
    const first = await evidence(a.token, it1.sku.toLowerCase()); // SKU lookup is case-insensitive
    expect(first.item).toMatchObject({
      status: "evidence", ref: `item:${it1.id}:v1`, itemId: it1.id, version: 1, kind: "product", name: "Widget", description: "d", unit: "pcs",
      category: { id: cat, name: "Hardware" }, features: [{ name: "Color", value: "Red" }],
    });
    expect(first.item.approvedAt).toBeTruthy();

    await api.call("POST", `/catalog/items/${it1.id}/versions`, { token: a.token });
    await api.call("PATCH", `/catalog/items/${it1.id}`, { token: a.token, body: { name: "Widget NEXT" } });
    const whileDrafting = await evidence(a.token, it1.sku);
    expect(whileDrafting.item).toMatchObject({ ref: `item:${it1.id}:v1`, name: "Widget" }); // the draft is invisible
    await api.call("POST", `/catalog/items/${it1.id}/approve`, { token: a.token });
    expect((await evidence(a.token, it1.sku)).item).toMatchObject({ ref: `item:${it1.id}:v2`, name: "Widget NEXT" });
  });

  it("archived items stop being evidence and come back on restore", async () => {
    const a = await register("arch");
    const it1 = await newItem(a.token);
    await api.call("POST", `/catalog/items/${it1.id}/archive`, { token: a.token });
    expect((await evidence(a.token, it1.sku)).item).toEqual({ status: "no_evidence", reason: "item_archived" });
    await api.call("POST", `/catalog/items/${it1.id}/restore`, { token: a.token });
    expect((await evidence(a.token, it1.sku)).item.status).toBe("evidence");
  });
});

describe("lookup: prices", () => {
  it("returns price evidence only for an approved list, with a ref that names that exact price", async () => {
    const a = await register("price");
    const it1 = await newItem(a.token);
    const list = await approvedList(a.token, [it1], "120.5", { validFrom: "2026-01-01", validUntil: "2026-12-31" });
    const res = await evidence(a.token, it1.sku, list);
    expect(res.price).toMatchObject({
      status: "evidence", priceListId: list, itemId: it1.id, unitPrice: "120.5000", currency: "MXN", validFrom: "2026-01-01", validUntil: "2026-12-31",
    });
    expect(res.price.ref).toBe(`price:${res.price.entryId}`);
  });

  it.each([
    ["draft list", "price_list_not_approved"],
    ["archived list", "price_list_archived"],
    ["unknown list", "price_list_not_found"],
    ["item without a price", "no_price_for_item"],
  ])("%s -> no_evidence (%s) while item evidence is unaffected", async (name, reason) => {
    const a = await register("price-no");
    const it1 = await newItem(a.token);
    const other = await newItem(a.token);
    let listId: string;
    if (name === "unknown list") listId = randomUUID();
    else if (name === "draft list") {
      listId = (await api.call("POST", "/catalog/price-lists", { token: a.token, body: { name: "D", currency: "USD" } })).body.id;
      await api.call("PUT", `/catalog/price-lists/${listId}/entries/${it1.id}`, { token: a.token, body: { unitPrice: "5" } });
    } else {
      listId = await approvedList(a.token, [name === "archived list" ? it1 : other]);
      if (name === "archived list") await api.call("POST", `/catalog/price-lists/${listId}/archive`, { token: a.token });
    }
    const res = await evidence(a.token, it1.sku, listId);
    expect(res.item.status).toBe("evidence");
    expect(res.price).toEqual({ status: "no_evidence", reason });
  });

  it("an item archived after its list was approved loses its price evidence", async () => {
    const a = await register("price-arch");
    const it1 = await newItem(a.token);
    const list = await approvedList(a.token, [it1]);
    await api.call("POST", `/catalog/items/${it1.id}/archive`, { token: a.token });
    const res = await evidence(a.token, it1.sku, list);
    expect(res.item).toEqual({ status: "no_evidence", reason: "item_archived" });
    expect(res.price).toEqual({ status: "no_evidence", reason: "item_not_approved" });
  });

  it("rejects malformed queries", async () => {
    const a = await register("badq");
    for (const q of ["", "sku=has space", `sku=X&priceListId=nope`, "sku=X&extra=1", `sku=${"x".repeat(65)}`]) {
      expect((await api.call("GET", `/catalog/evidence${q ? `?${q}` : ""}`, { token: a.token })).status).toBe(400);
    }
  });
});

describe("resolve: checking citations", () => {
  it("classifies item refs as current / superseded / archived / no_evidence", async () => {
    const a = await register("res-item");
    const it1 = await newItem(a.token, { name: "V1 name" });
    const drafted = await newItem(a.token, {}, false);
    const v1 = `item:${it1.id}:v1`;
    expect((await resolve(a.token, [v1]))[0]).toMatchObject({ ref: v1, status: "current", evidence: { name: "V1 name", version: 1 } });

    await api.call("POST", `/catalog/items/${it1.id}/versions`, { token: a.token });
    const v2 = `item:${it1.id}:v2`;
    const midway = await resolve(a.token, [v1, v2]);
    expect(midway[0]?.status).toBe("current"); // v1 is still the approved one
    expect(midway[1]).toEqual({ ref: v2, status: "no_evidence", reason: "not_approved" }); // a draft cannot be cited
    await api.call("POST", `/catalog/items/${it1.id}/approve`, { token: a.token });
    const after = await resolve(a.token, [v1, v2]);
    expect(after[0]).toEqual({ ref: v1, status: "superseded", currentRef: v2 }); // tells the citer what to cite now, without content
    expect(after[1]?.status).toBe("current");

    await api.call("POST", `/catalog/items/${it1.id}/archive`, { token: a.token });
    expect(await resolve(a.token, [v1, v2])).toEqual([
      { ref: v1, status: "archived", reason: "item_archived" },
      { ref: v2, status: "archived", reason: "item_archived" },
    ]);
    expect((await resolve(a.token, [`item:${drafted.id}:v1`]))[0]).toMatchObject({ status: "no_evidence", reason: "not_approved" });
  });

  it("classifies price refs and treats invented or malformed refs as answers, not errors", async () => {
    const a = await register("res-price");
    const it1 = await newItem(a.token);
    const list = await approvedList(a.token, [it1], "10");
    const ref = (await evidence(a.token, it1.sku, list)).price.ref as string;
    const refs = [ref, `price:${randomUUID()}`, `item:${randomUUID()}:v1`, "price:not-a-uuid", "item:abc", "totally made up", `item:${it1.id}:v0`];
    const results = await resolve(a.token, refs);
    expect(results[0]).toMatchObject({ ref, status: "current", evidence: { unitPrice: "10.0000", currency: "MXN" } });
    expect(results.slice(1).map((r) => [r.status, r.reason])).toEqual([
      ["no_evidence", "unknown_ref"], ["no_evidence", "unknown_ref"], ["no_evidence", "malformed_ref"], ["no_evidence", "malformed_ref"],
      ["no_evidence", "malformed_ref"], ["no_evidence", "malformed_ref"],
    ]);

    await api.call("POST", `/catalog/items/${it1.id}/archive`, { token: a.token });
    expect((await resolve(a.token, [ref]))[0]).toEqual({ ref, status: "no_evidence", reason: "item_not_approved" });
    await api.call("POST", `/catalog/items/${it1.id}/restore`, { token: a.token });
    await api.call("POST", `/catalog/price-lists/${list}/archive`, { token: a.token });
    expect((await resolve(a.token, [ref]))[0]).toEqual({ ref, status: "archived", reason: "price_list_archived" });
  });

  it("a price of a draft list is not citable", async () => {
    const a = await register("res-draft");
    const it1 = await newItem(a.token);
    const list = (await api.call("POST", "/catalog/price-lists", { token: a.token, body: { name: "D", currency: "MXN" } })).body.id;
    const entry = (await api.call("PUT", `/catalog/price-lists/${list}/entries/${it1.id}`, { token: a.token, body: { unitPrice: "7" } })).body.id;
    expect((await resolve(a.token, [`price:${entry}`]))[0]).toEqual({ ref: `price:${entry}`, status: "no_evidence", reason: "price_list_not_approved" });
  });

  it("keeps order, handles duplicates and enforces batch limits", async () => {
    const a = await register("res-batch");
    const it1 = await newItem(a.token);
    const ref = `item:${it1.id}:v1`;
    const results = await resolve(a.token, [ref, "nonsense", ref]);
    expect(results.map((r) => r.status)).toEqual(["current", "no_evidence", "current"]);
    expect((await api.call("POST", "/catalog/evidence/resolve", { token: a.token, body: { refs: [] } })).status).toBe(400);
    expect((await api.call("POST", "/catalog/evidence/resolve", { token: a.token, body: { refs: Array.from({ length: 51 }, () => ref) } })).status).toBe(400);
    expect((await api.call("POST", "/catalog/evidence/resolve", { token: a.token, body: { refs: ["x".repeat(101)] } })).status).toBe(400);
    expect((await api.call("POST", "/catalog/evidence/resolve", { token: a.token, body: { refs: [ref], organization_id: randomUUID() } })).status).toBe(400);
  });
});

describe("access", () => {
  it.each(MEMBERSHIP_ROLES)("%s can read evidence", async (role: MembershipRole) => {
    const a = await register(`rbac-${role}`);
    const it1 = await newItem(a.token);
    const m = await seedMember(a.orgId, role);
    const token = role === "org_admin" ? a.token : (await api.call("POST", "/auth/login", { body: { email: m.email, password: PASSWORD } })).body.token;
    expect((await evidence(token, it1.sku)).item.status).toBe("evidence");
    expect((await resolve(token, [`item:${it1.id}:v1`]))[0]?.status).toBe("current");
  });

  it("requires authentication", async () => {
    expect((await api.call("GET", "/catalog/evidence?sku=X")).status).toBe(401);
    expect((await api.call("POST", "/catalog/evidence/resolve", { body: { refs: ["x"] } })).status).toBe(401);
  });

  it("tenant B gets no evidence for tenant A's SKUs, lists, items and prices (indistinguishable from nonexistent)", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    const it1 = await newItem(a.token, { name: "A's secret product" });
    const list = await approvedList(a.token, [it1], "42");
    const aPrice = (await evidence(a.token, it1.sku, list)).price.ref as string;

    const bView = await evidence(b.token, it1.sku, list);
    expect(bView).toEqual({ sku: it1.sku, item: { status: "no_evidence", reason: "item_not_found" }, price: { status: "no_evidence", reason: "price_list_not_found" } });
    expect(JSON.stringify(bView)).not.toContain("secret");
    const results = await resolve(b.token, [`item:${it1.id}:v1`, aPrice]);
    expect(results.map((r) => [r.status, r.reason])).toEqual([["no_evidence", "unknown_ref"], ["no_evidence", "unknown_ref"]]);
    expect(await resolve(a.token, [`item:${it1.id}:v1`, aPrice])).toHaveLength(2);

    // same SKU in B is B's own fact
    const mine = await api.call("POST", "/catalog/items", { token: b.token, body: { kind: "service", sku: it1.sku, name: "B's own" } });
    await api.call("POST", `/catalog/items/${mine.body.id}/approve`, { token: b.token });
    expect((await evidence(b.token, it1.sku)).item).toMatchObject({ name: "B's own", itemId: mine.body.id });
  });
});

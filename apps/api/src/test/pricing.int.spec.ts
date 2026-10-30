import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMBERSHIP_ROLES, type MembershipRole } from "@prospecting/contracts";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** P3-03: price lists - immutability, approval rules, consumption view (only approved list + approved item), RBAC, isolation. */
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
  const login = await api.call("POST", "/auth/login", { body: { email: m.email, password: PASSWORD } });
  return { token: login.body.token as string, userId: m.userId };
}
const sku = () => `SKU-${randomUUID().slice(0, 8)}`;
/** An approved item (consumable) unless `approve` is false. */
async function item(t: string, approve = true, name = "Widget"): Promise<{ id: string; sku: string }> {
  const res = await api.call("POST", "/catalog/items", { token: t, body: { kind: "product", sku: sku(), name } });
  if (approve) await api.call("POST", `/catalog/items/${res.body.id}/approve`, { token: t });
  return { id: res.body.id, sku: res.body.sku };
}
const newList = (t: string, body: Record<string, unknown> = {}) => api.call("POST", "/catalog/price-lists", { token: t, body: { name: `List ${randomUUID().slice(0, 8)}`, currency: "MXN", ...body } });
const setPrice = (t: string, listId: string, itemId: string, unitPrice: unknown) => api.call("PUT", `/catalog/price-lists/${listId}/entries/${itemId}`, { token: t, body: { unitPrice } });
const listAction = (t: string, listId: string, action: "approve" | "archive") => api.call("POST", `/catalog/price-lists/${listId}/${action}`, { token: t });
const prices = (t: string, listId: string, q = "") => api.call("GET", `/catalog/price-lists/${listId}/approved-prices${q}`, { token: t });
const ctxOf = (a: { orgId: string; userId: string }, role: string) => ({ organizationId: a.orgId, userId: a.userId, role });
const denied = (ctx: { organizationId: string; userId: string; role: string }, sql: string, params: unknown[] = []) =>
  asRuntime(ctx, async (c) => c.query(sql, params).then(() => "NO ERROR", (e: Error) => e.message));

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("nothing is invented", () => {
  it("a new organization has no price lists, and an empty list cannot be approved", async () => {
    const a = await register("empty");
    expect((await api.call("GET", "/catalog/price-lists", { token: a.token })).body).toEqual({ items: [], nextCursor: null });
    const list = await newList(a.token);
    expect(list.body).toMatchObject({ status: "draft", entryCount: 0, currency: "MXN", validFrom: null, validUntil: null });
    expect((await listAction(a.token, list.body.id, "approve")).status).toBe(409);
  });
});

describe("lifecycle and consumption", () => {
  it("only an approved list with approved items exposes prices; item changes flow through, archiving hides", async () => {
    const a = await register("flow");
    const widget = await item(a.token, true, "Widget");
    const draftOnly = await item(a.token, false, "Not ready");
    const list = (await newList(a.token, { validFrom: "2026-01-01", validUntil: "2026-12-31" })).body.id as string;

    expect((await setPrice(a.token, list, widget.id, "100.5")).body).toMatchObject({ itemId: widget.id, sku: widget.sku, unitPrice: "100.5000" });
    expect((await setPrice(a.token, list, widget.id, "120")).body.unitPrice).toBe("120.0000"); // idempotent upsert
    await setPrice(a.token, list, draftOnly.id, "5");
    expect((await prices(a.token, list)).status).toBe(409); // draft list is not consumable

    const blocked = await listAction(a.token, list, "approve");
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.skus).toEqual([draftOnly.sku]); // names the offending items
    expect((await api.call("DELETE", `/catalog/price-lists/${list}/entries/${draftOnly.id}`, { token: a.token })).status).toBe(204);

    const approved = await listAction(a.token, list, "approve");
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: "approved", entryCount: 1, approvedBy: a.userId, validFrom: "2026-01-01", validUntil: "2026-12-31" });

    const view = await prices(a.token, list);
    expect(view.body.items).toEqual([
      expect.objectContaining({ priceListId: list, itemId: widget.id, sku: widget.sku, kind: "product", itemVersion: 1, itemName: "Widget", unitPrice: "120.0000", currency: "MXN", validFrom: "2026-01-01" }),
    ]);

    // a newer approved item version changes what consumers see (name/version), the price stays bound to the stable item
    await api.call("POST", `/catalog/items/${widget.id}/versions`, { token: a.token });
    await api.call("PATCH", `/catalog/items/${widget.id}`, { token: a.token, body: { name: "Widget v2" } });
    expect((await prices(a.token, list)).body.items[0]).toMatchObject({ itemVersion: 1, itemName: "Widget" }); // draft not visible
    await api.call("POST", `/catalog/items/${widget.id}/approve`, { token: a.token });
    expect((await prices(a.token, list)).body.items[0]).toMatchObject({ itemVersion: 2, itemName: "Widget v2", unitPrice: "120.0000" });

    await api.call("POST", `/catalog/items/${widget.id}/archive`, { token: a.token });
    expect((await prices(a.token, list)).body.items).toEqual([]);
    await api.call("POST", `/catalog/items/${widget.id}/restore`, { token: a.token });
    expect((await prices(a.token, list)).body.items).toHaveLength(1);

    expect((await listAction(a.token, list, "archive")).body.status).toBe("archived");
    expect((await prices(a.token, list)).status).toBe(409);
  });

  it("approved lists are immutable through the API and at the database, even for the table owner", async () => {
    const a = await register("immut");
    const it1 = await item(a.token);
    const it2 = await item(a.token);
    const list = (await newList(a.token)).body.id as string;
    await setPrice(a.token, list, it1.id, "10");
    await listAction(a.token, list, "approve");

    expect((await setPrice(a.token, list, it1.id, "11")).status).toBe(409);
    expect((await setPrice(a.token, list, it2.id, "11")).status).toBe(409);
    expect((await api.call("DELETE", `/catalog/price-lists/${list}/entries/${it1.id}`, { token: a.token })).status).toBe(409);
    expect((await api.call("PATCH", `/catalog/price-lists/${list}`, { token: a.token, body: { name: "renamed" } })).status).toBe(409);
    expect((await listAction(a.token, list, "approve")).status).toBe(409);

    await expect(owner.query("UPDATE price_list_entries SET unit_price = 1 WHERE price_list_id = $1", [list])).rejects.toThrow(/draft/);
    await expect(owner.query("DELETE FROM price_list_entries WHERE price_list_id = $1", [list])).rejects.toThrow(/draft/);
    await expect(owner.query("INSERT INTO price_list_entries (organization_id, price_list_id, item_id, unit_price, created_by, updated_at) VALUES ($1,$2,$3,5,$4, now())", [a.orgId, list, it2.id, a.userId])).rejects.toThrow(/draft/);
    await expect(owner.query("UPDATE price_lists SET name = 'x', name_key = 'x' WHERE id = $1", [list])).rejects.toThrow(/immutable/);
    expect(await denied(ctxOf(a, "org_admin"), "UPDATE price_lists SET status = 'draft', approved_at = NULL, approved_by = NULL WHERE id = $1", [list])).toMatch(/immutable/);
    expect(await denied(ctxOf(a, "org_admin"), "DELETE FROM price_lists", [])).toMatch(/permission denied/);
  });

  it("the database refuses to approve a list with unapproved items or no prices, even by direct SQL", async () => {
    const a = await register("dbapprove");
    const draftItem = await item(a.token, false);
    const list = (await newList(a.token)).body.id as string;
    const approveSql = "UPDATE price_lists SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1";
    expect(await denied(ctxOf(a, "org_admin"), approveSql, [list, a.userId])).toMatch(/at least one entry/);
    await setPrice(a.token, list, draftItem.id, "1");
    expect(await denied(ctxOf(a, "org_admin"), approveSql, [list, a.userId])).toMatch(/approved and not archived/);
  });

  it("serializes approval against concurrent edits: a late edit is rejected, never silently lost", async () => {
    const a = await register("race");
    const first = await item(a.token);
    const second = await item(a.token);
    const list = (await newList(a.token)).body.id as string;
    await setPrice(a.token, list, first.id, "10");
    const [approve, late] = await Promise.all([listAction(a.token, list, "approve"), setPrice(a.token, list, second.id, "20")]);
    expect(approve.status).toBe(200);
    const stored = (await owner.query("SELECT 1 FROM price_list_entries WHERE price_list_id = $1 AND item_id = $2", [list, second.id])).rowCount;
    expect(late.status === 200 ? stored === 1 : stored === 0).toBe(true); // outcome and state agree
    expect(late.status === 200 || late.status === 409).toBe(true);
    const approvals = await Promise.all([listAction(a.token, (await newList(a.token)).body.id, "approve"), listAction(a.token, list, "approve")]);
    expect(approvals.map((r) => r.status)).toEqual([409, 409]); // empty list / already approved
  });
});

describe("clone and archive", () => {
  it("clones any list into an editable draft with all entries, leaving the original intact", async () => {
    const a = await register("clone");
    const it1 = await item(a.token);
    const list = (await newList(a.token, { currency: "USD" })).body.id as string;
    await setPrice(a.token, list, it1.id, "9.99");
    await listAction(a.token, list, "approve");
    const copy = await api.call("POST", `/catalog/price-lists/${list}/clone`, { token: a.token, body: { name: "Q2 prices" } });
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ status: "draft", currency: "USD", entryCount: 1, clonedFrom: list, approvedAt: null });
    expect((await setPrice(a.token, copy.body.id, it1.id, "10.99")).status).toBe(200);
    expect((await prices(a.token, list)).body.items[0].unitPrice).toBe("9.9900");
    expect((await api.call("POST", `/catalog/price-lists/${list}/clone`, { token: a.token, body: { name: "q2 PRICES" } })).status).toBe(409);
    await listAction(a.token, list, "archive");
    expect((await api.call("POST", `/catalog/price-lists/${list}/clone`, { token: a.token, body: { name: "From archived" } })).status).toBe(201);
    expect((await listAction(a.token, list, "archive")).status).toBe(409);
  });

  it("draft lists can be edited and discarded (archived); names are unique per organization only", async () => {
    const a = await register("edit-a");
    const b = await register("edit-b");
    const list = (await newList(a.token, { name: "Retail" })).body.id as string;
    expect((await newList(a.token, { name: "RETAIL" })).status).toBe(409);
    expect((await newList(b.token, { name: "Retail" })).status).toBe(201);
    const edited = await api.call("PATCH", `/catalog/price-lists/${list}`, { token: a.token, body: { name: "Retail 2026", validFrom: "2026-03-01" } });
    expect(edited.body).toMatchObject({ name: "Retail 2026", validFrom: "2026-03-01" });
    expect((await api.call("PATCH", `/catalog/price-lists/${list}`, { token: a.token, body: { validUntil: "2026-02-01" } })).status).toBe(400);
    expect((await listAction(a.token, list, "archive")).body.status).toBe("archived");
    expect((await api.call("PATCH", `/catalog/price-lists/${list}`, { token: a.token, body: { name: "x" } })).status).toBe(409);
  });
});

describe("validation", () => {
  it.each([
    ["integer", "10", 200, "10.0000"],
    ["four decimals", "0.0001", 200, "0.0001"],
    ["zero", "0", 200, "0.0000"],
    ["max digits", "99999999999999.9999", 200, "99999999999999.9999"],
  ])("accepts %s", async (_n, value, status, shown) => {
    const a = await register("money-ok");
    const it1 = await item(a.token);
    const list = (await newList(a.token)).body.id as string;
    const res = await setPrice(a.token, list, it1.id, value);
    expect(res.status).toBe(status);
    expect(res.body.unitPrice).toBe(shown);
  });

  it.each([
    ["JSON number", 10],
    ["negative", "-1"],
    ["five decimals", "1.00001"],
    ["exponent", "1e3"],
    ["too many integer digits", "123456789012345"],
    ["comma", "1,5"],
    ["empty", ""],
    ["spaces", " 1"],
    ["null", null],
  ])("rejects price as %s", async (_n, value) => {
    const a = await register("money-bad");
    const it1 = await item(a.token);
    const list = (await newList(a.token)).body.id as string;
    expect((await setPrice(a.token, list, it1.id, value)).status).toBe(400);
    expect((await prices(a.token, list)).status).toBe(409);
    expect((await api.call("GET", `/catalog/price-lists/${list}/entries`, { token: a.token })).body.items).toEqual([]);
  });

  it.each([
    ["lowercase currency", { currency: "mxn" }],
    ["unknown currency", { currency: "ZZZ" }],
    ["long name", { name: "x".repeat(121) }],
    ["empty name", { name: " " }],
    ["bad date", { validFrom: "2026-13-40" }],
    ["until before from", { validFrom: "2026-05-01", validUntil: "2026-04-30" }],
    ["tenant id", { organization_id: randomUUID() }],
    ["status on create", { status: "approved" }],
  ])("rejects list with %s", async (_n, patch) => {
    const a = await register("list-bad");
    expect((await newList(a.token, patch)).status).toBe(400);
  });

  it("currency is immutable, empty or unknown patches fail, items of other tenants and archived items cannot be priced", async () => {
    const a = await register("misc-a");
    const b = await register("misc-b");
    const list = (await newList(a.token)).body.id as string;
    for (const body of [{}, { currency: "USD" }, { status: "approved" }, { organizationId: randomUUID() }]) {
      expect((await api.call("PATCH", `/catalog/price-lists/${list}`, { token: a.token, body })).status).toBe(400);
    }
    const foreign = await item(b.token);
    expect((await setPrice(a.token, list, foreign.id, "1")).status).toBe(404);
    expect((await setPrice(a.token, list, randomUUID(), "1")).status).toBe(404);
    const mine = await item(a.token);
    await api.call("POST", `/catalog/items/${mine.id}/archive`, { token: a.token });
    expect((await setPrice(a.token, list, mine.id, "1")).status).toBe(409);
    expect((await api.call("DELETE", `/catalog/price-lists/${list}/entries/${randomUUID()}`, { token: a.token })).status).toBe(404);
    expect((await api.call("GET", "/catalog/price-lists?cursor=nope", { token: a.token })).status).toBe(400);
  });
});

describe("pagination and audit", () => {
  it("walks lists, entries and the consumption view by cursor without gaps or duplicates", async () => {
    const a = await register("page");
    const items = [await item(a.token), await item(a.token), await item(a.token)];
    const list = (await newList(a.token)).body.id as string;
    for (const [i, it1] of items.entries()) await setPrice(a.token, list, it1.id, String(i + 1));
    for (let i = 0; i < 2; i++) await newList(a.token);
    await listAction(a.token, list, "approve");

    const walk = async (path: string, key: (x: Record<string, string>) => string) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const res = await api.call("GET", `${path}${path.includes("?") ? "&" : "?"}limit=2${cursor ? `&cursor=${cursor}` : ""}`, { token: a.token });
        seen.push(...res.body.items.map(key));
        cursor = res.body.nextCursor;
        if (!cursor) break;
      }
      return seen;
    };
    const lists = await walk("/catalog/price-lists", (x) => x.id!);
    expect(lists).toHaveLength(3);
    expect(new Set(lists).size).toBe(3);
    expect(await walk(`/catalog/price-lists/${list}/entries`, (x) => x.itemId!)).toHaveLength(3);
    expect((await walk(`/catalog/price-lists/${list}/approved-prices`, (x) => x.itemId!)).sort()).toEqual(items.map((i) => i.id).sort());
    expect((await api.call("GET", "/catalog/price-lists?status=approved", { token: a.token })).body.items).toHaveLength(1);
  });

  it("audits who did what to which list/item, never the amounts", async () => {
    const a = await register("audit");
    const it1 = await item(a.token);
    const list = (await newList(a.token)).body.id as string;
    await setPrice(a.token, list, it1.id, "123.4567");
    await setPrice(a.token, list, it1.id, "765.4321");
    await listAction(a.token, list, "approve");
    const events = (await api.call("GET", "/audit-events?limit=100", { token: a.token })).body as Array<{ action: string; metadata: Record<string, unknown> }>;
    const names = events.map((e) => e.action);
    expect(names).toEqual(expect.arrayContaining(["pricing.list_created", "pricing.price_set", "pricing.price_updated", "pricing.list_approved"]));
    expect(JSON.stringify(events)).not.toMatch(/123\.4567|765\.4321/);
    expect(events.find((e) => e.action === "pricing.price_set")?.metadata).toEqual({ itemId: it1.id });
  });
});

describe("RBAC matrix (same as the catalog)", () => {
  const expected: Record<MembershipRole, { read: number; manage: number; approve: number }> = {
    org_admin: { read: 200, manage: 200, approve: 200 },
    sales_manager: { read: 200, manage: 200, approve: 403 },
    campaign_manager: { read: 200, manage: 403, approve: 403 },
    seller: { read: 200, manage: 403, approve: 403 },
    analyst: { read: 200, manage: 403, approve: 403 },
    viewer: { read: 200, manage: 403, approve: 403 },
  };
  it("covers every role", () => expect(Object.keys(expected).sort()).toEqual([...MEMBERSHIP_ROLES].sort()));

  it.each(MEMBERSHIP_ROLES)("%s gets exactly its pricing permissions", async (role) => {
    const a = await register(`rbac-${role}`);
    const it1 = await item(a.token);
    const draft = (await newList(a.token)).body.id as string;
    await setPrice(a.token, draft, it1.id, "5");
    const token = role === "org_admin" ? a.token : (await member(a.orgId, role)).token;
    const e = expected[role];
    expect((await api.call("GET", "/catalog/price-lists", { token })).status).toBe(e.read);
    expect((await api.call("GET", `/catalog/price-lists/${draft}/entries`, { token })).status).toBe(e.read);
    expect((await newList(token)).status).toBe(e.manage === 200 ? 201 : 403);
    expect((await setPrice(token, draft, it1.id, "6")).status).toBe(e.manage);
    expect((await api.call("POST", `/catalog/price-lists/${draft}/clone`, { token, body: { name: `clone ${role}` } })).status).toBe(e.manage === 200 ? 201 : 403);
    expect((await listAction(token, draft, "approve")).status).toBe(e.approve);
    const approvedNow = e.approve === 200;
    expect((await prices(token, draft)).status).toBe(approvedNow ? 200 : 409);
    expect((await listAction(token, draft, "archive")).status).toBe(e.approve === 200 ? 200 : 403);
  });

  it("sales_manager cannot approve or archive a list even with direct SQL", async () => {
    const a = await register("sm-db");
    const sm = await member(a.orgId, "sales_manager");
    const it1 = await item(a.token);
    const list = (await newList(sm.token)).body.id as string;
    await setPrice(sm.token, list, it1.id, "3");
    const ctx = ctxOf({ orgId: a.orgId, userId: sm.userId }, "sales_manager");
    expect(await denied(ctx, "UPDATE price_lists SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1", [list, sm.userId])).toMatch(/row-level security/);
    expect(await denied(ctx, "UPDATE price_lists SET status = 'archived', archived_at = now() WHERE id = $1", [list])).toMatch(/row-level security/);
  });
});

describe("tenant isolation", () => {
  it("tenant B cannot read or change tenant A's lists, entries or consumption view; DB constraints agree", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    const aItem = await item(a.token);
    const aList = (await newList(a.token, { name: "Shared name" })).body.id as string;
    await setPrice(a.token, aList, aItem.id, "50");
    await listAction(a.token, aList, "approve");

    expect((await api.call("GET", "/catalog/price-lists", { token: b.token })).body.items).toEqual([]);
    for (const [method, path, body] of [
      ["GET", `/catalog/price-lists/${aList}`, undefined],
      ["PATCH", `/catalog/price-lists/${aList}`, { name: "pwned" }],
      ["GET", `/catalog/price-lists/${aList}/entries`, undefined],
      ["GET", `/catalog/price-lists/${aList}/approved-prices`, undefined],
      ["POST", `/catalog/price-lists/${aList}/clone`, { name: "stolen" }],
      ["POST", `/catalog/price-lists/${aList}/archive`, undefined],
      ["PUT", `/catalog/price-lists/${aList}/entries/${aItem.id}`, { unitPrice: "1" }],
      ["DELETE", `/catalog/price-lists/${aList}/entries/${aItem.id}`, undefined],
    ] as const) {
      expect((await api.call(method, path, { token: b.token, ...(body ? { body } : {}) })).status).toBe(404);
    }
    expect((await newList(b.token, { name: "Shared name" })).status).toBe(201); // names are per tenant
    expect((await prices(a.token, aList)).body.items[0].unitPrice).toBe("50.0000");

    const bList = (await newList(b.token)).body.id as string;
    await expect(
      owner.query("INSERT INTO price_list_entries (organization_id, price_list_id, item_id, unit_price, created_by, updated_at) VALUES ($1,$2,$3,1,$4, now())", [b.orgId, bList, aItem.id, b.userId]),
    ).rejects.toThrow(/foreign key/); // composite FK: an entry cannot mix organizations

    const ctx = ctxOf(b, "org_admin");
    await asRuntime(ctx, async (c) => {
      expect((await c.query("SELECT 1 FROM price_lists WHERE id = $1", [aList])).rowCount).toBe(0);
      expect((await c.query("SELECT 1 FROM price_list_entries WHERE price_list_id = $1", [aList])).rowCount).toBe(0);
      expect((await c.query("UPDATE price_lists SET name = 'x' WHERE id = $1", [aList])).rowCount).toBe(0);
    });
    expect(await denied(ctx, "INSERT INTO price_lists (organization_id, name, name_key, currency, created_by, updated_at) VALUES ($1,'x','x','MXN',$2, now())", [a.orgId, b.userId])).toMatch(/row-level security/);
    expect(await denied(ctx, "UPDATE price_lists SET organization_id = $1 WHERE id = $2", [a.orgId, bList])).toMatch(/permission denied/);
    expect(await denied(ctxOf(b, "org_admin"), "UPDATE price_lists SET currency = 'USD' WHERE id = $1", [bList])).toMatch(/permission denied/); // currency immutable in SQL too
  });
});

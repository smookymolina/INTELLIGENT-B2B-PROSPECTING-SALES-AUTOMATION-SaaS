import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMBERSHIP_ROLES, type MembershipRole } from "@prospecting/contracts";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** P3-02: catalog base - lifecycle/versioning, immutability, RBAC matrix (read all / manage admin+sales_manager / approve admin), isolation. */
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
const createItem = (t: string, body: Record<string, unknown> = {}) => api.call("POST", "/catalog/items", { token: t, body: { kind: "product", sku: sku(), name: "Widget", ...body } });
const act = (t: string, id: string, action: "approve" | "archive" | "restore") => api.call("POST", `/catalog/items/${id}/${action}`, { token: t });
const ctxOf = (a: { orgId: string; userId: string }, role: string) => ({ organizationId: a.orgId, userId: a.userId, role });
const denied = (ctx: { organizationId: string; userId: string; role: string }, sql: string, params: unknown[] = []) =>
  asRuntime(ctx, async (c) => c.query(sql, params).then(() => "NO ERROR", (e: Error) => e.message));

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("lifecycle and versioning", () => {
  it("draft -> approved -> new draft -> approved supersedes; approved content never changes while a draft is edited", async () => {
    const a = await register("life");
    const created = await createItem(a.token, { description: "first", unit: "pcs", features: [{ name: "Color", value: "Red" }] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: "draft", latestVersion: 1, approvedVersion: null, approved: null, draft: { version: 1, state: "draft", name: "Widget", unit: "pcs" } });
    const id = created.body.id as string;

    const edited = await api.call("PATCH", `/catalog/items/${id}`, { token: a.token, body: { name: "Widget Pro", description: null } });
    expect(edited.body.draft).toMatchObject({ name: "Widget Pro", description: null, unit: "pcs" });

    const approved = await act(a.token, id, "approve");
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: "approved", approvedVersion: 1, draft: null, approved: { version: 1, state: "approved", name: "Widget Pro", approvedBy: a.userId } });
    expect(approved.body.approved.approvedAt).toBeTruthy();

    const v2 = await api.call("POST", `/catalog/items/${id}/versions`, { token: a.token });
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({ status: "approved", latestVersion: 2, draft: { version: 2, name: "Widget Pro", features: [{ name: "Color", value: "Red" }] } });
    await api.call("PATCH", `/catalog/items/${id}`, { token: a.token, body: { name: "Widget Max", features: [] } });
    const mid = await api.call("GET", `/catalog/items/${id}`, { token: a.token });
    expect(mid.body.approved).toMatchObject({ version: 1, name: "Widget Pro", features: [{ name: "Color", value: "Red" }] }); // consumers still see v1
    expect(mid.body.draft).toMatchObject({ version: 2, name: "Widget Max" });

    const second = await act(a.token, id, "approve");
    expect(second.body).toMatchObject({ approvedVersion: 2, approved: { version: 2, name: "Widget Max" }, draft: null });
    const versions = (await api.call("GET", `/catalog/items/${id}/versions`, { token: a.token })).body as Array<{ version: number; state: string }>;
    expect(versions.map((v) => [v.version, v.state])).toEqual([[2, "approved"], [1, "superseded"]]);

    const actions = (await api.call("GET", "/audit-events?limit=100", { token: a.token })).body as Array<{ action: string; metadata: Record<string, unknown> }>;
    expect(actions.map((e) => e.action)).toEqual(expect.arrayContaining(["catalog.item_created", "catalog.item_draft_updated", "catalog.item_approved", "catalog.item_version_created"]));
    expect(JSON.stringify(actions)).not.toContain("Widget Max"); // audit holds ids/field names, not content
    expect(actions.find((e) => e.action === "catalog.item_approved" && e.metadata.version === 2)?.metadata).toMatchObject({ supersedes: 1 });
  });

  it("returns 409 for impossible transitions", async () => {
    const a = await register("trans");
    const { body } = await createItem(a.token);
    const id = body.id as string;
    expect((await api.call("POST", `/catalog/items/${id}/versions`, { token: a.token })).status).toBe(409); // draft already open
    expect((await act(a.token, id, "restore")).status).toBe(409); // not archived
    await act(a.token, id, "approve");
    expect((await act(a.token, id, "approve")).status).toBe(409); // nothing to approve
    expect((await api.call("PATCH", `/catalog/items/${id}`, { token: a.token, body: { name: "x" } })).status).toBe(409); // no open draft
  });

  it("archiving hides approved content from consumers, blocks edits, and restore brings it back", async () => {
    const a = await register("arch");
    const id = (await createItem(a.token, { name: "Keep" })).body.id as string;
    await act(a.token, id, "approve");
    const archived = await act(a.token, id, "archive");
    expect(archived.body).toMatchObject({ status: "archived", approved: null, approvedVersion: 1 });
    expect(archived.body.archivedAt).toBeTruthy();
    expect((await act(a.token, id, "archive")).status).toBe(409);
    expect((await api.call("POST", `/catalog/items/${id}/versions`, { token: a.token })).status).toBe(409);
    expect((await api.call("GET", "/catalog/items?status=approved", { token: a.token })).body.items).toEqual([]);
    expect((await api.call("GET", "/catalog/items?status=archived", { token: a.token })).body.items).toHaveLength(1);
    const restored = await act(a.token, id, "restore");
    expect(restored.body).toMatchObject({ status: "approved", approved: { name: "Keep" } });
  });

  it("serializes concurrent approvals and drafts", async () => {
    const a = await register("race");
    const id = (await createItem(a.token)).body.id as string;
    const approvals = await Promise.all([act(a.token, id, "approve"), act(a.token, id, "approve")]);
    expect(approvals.map((r) => r.status).sort()).toEqual([200, 409]);
    const drafts = await Promise.all([1, 2].map(() => api.call("POST", `/catalog/items/${id}/versions`, { token: a.token })));
    expect(drafts.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await owner.query("SELECT count(*)::int AS n FROM catalog_item_versions WHERE item_id = $1 AND state = 'draft'", [id])).rows[0].n).toBe(1);
  });
});

describe("integrity at the database", () => {
  it("approved and superseded versions are immutable for every role, including the table owner", async () => {
    const a = await register("immut");
    const id = (await createItem(a.token)).body.id as string;
    await act(a.token, id, "approve");
    const ctx = ctxOf(a, "org_admin");
    expect(await denied(ctx, "UPDATE catalog_item_versions SET name = 'tampered' WHERE item_id = $1", [id])).toMatch(/immutable/);
    expect(await denied(ctx, "UPDATE catalog_item_versions SET state = 'draft' WHERE item_id = $1", [id])).toMatch(/immutable/);
    await expect(owner.query("UPDATE catalog_item_versions SET name = 'tampered' WHERE item_id = $1", [id])).rejects.toThrow(/immutable/);
    expect(await denied(ctx, "DELETE FROM catalog_item_versions", [])).toMatch(/permission denied/);
    expect(await denied(ctx, "DELETE FROM catalog_items", [])).toMatch(/permission denied/);
  });

  it("sales_manager can edit drafts but cannot approve, archive or supersede even with direct SQL", async () => {
    const a = await register("sm-db");
    const sm = await member(a.orgId, "sales_manager");
    const id = (await createItem(sm.token)).body.id as string;
    const ctx = ctxOf({ orgId: a.orgId, userId: sm.userId }, "sales_manager");
    expect(await denied(ctx, "UPDATE catalog_item_versions SET state = 'approved', approved_by = $2, approved_at = now() WHERE item_id = $1", [id, sm.userId])).toMatch(/row-level security/);
    expect(await denied(ctx, "UPDATE catalog_items SET archived_at = now() WHERE id = $1", [id])).toMatch(/only org_admin/);
    expect(await denied(ctx, "UPDATE catalog_items SET approved_version = 1 WHERE id = $1", [id])).toMatch(/only org_admin/);
  });

  it("a version cannot point to another organization's category or item", async () => {
    const a = await register("xref-a");
    const b = await register("xref-b");
    const bCat = (await api.call("POST", "/catalog/categories", { token: b.token, body: { name: "B cat" } })).body.id as string;
    const aItem = (await createItem(a.token)).body.id as string;
    const bItem = (await createItem(b.token)).body.id as string;
    await act(b.token, bItem, "approve"); // no open draft, so the composite FK (not the one-draft rule) is what rejects the insert
    const ctx = ctxOf(a, "org_admin");
    expect(await denied(ctx, "UPDATE catalog_item_versions SET category_id = $2 WHERE item_id = $1", [aItem, bCat])).toMatch(/another organization/);
    await expect(
      owner.query("INSERT INTO catalog_item_versions (organization_id, item_id, version, name, created_by) VALUES ($1,$2,9,'x',$3)", [a.orgId, bItem, a.userId]),
    ).rejects.toThrow(/foreign key/);
  });
});

describe("validation", () => {
  it.each([
    ["bad sku", { sku: "has space" }],
    ["empty sku", { sku: "" }],
    ["unknown kind", { kind: "bundle" }],
    ["empty name", { name: "  " }],
    ["unknown category", { categoryId: randomUUID() }],
    ["duplicate feature names", { features: [{ name: "Color", value: "a" }, { name: "color", value: "b" }] }],
    ["too many features", { features: Array.from({ length: 51 }, (_, i) => ({ name: `f${i}`, value: "v" })) }],
    ["price (not part of P3-02)", { price: 10 }],
    ["tenant id", { organization_id: randomUUID() }],
  ])("rejects %s", async (_n, patch) => {
    const a = await register("val");
    const res = await createItem(a.token, patch);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  it("rejects empty and unknown fields on edit, and malformed ids", async () => {
    const a = await register("val-edit");
    const id = (await createItem(a.token)).body.id as string;
    for (const body of [{}, { sku: "NEW" }, { kind: "service" }, { state: "approved" }, { organizationId: randomUUID() }]) {
      expect((await api.call("PATCH", `/catalog/items/${id}`, { token: a.token, body })).status).toBe(400);
    }
    expect((await api.call("GET", "/catalog/items/not-a-uuid", { token: a.token })).status).toBe(400);
  });

  it("enforces unique SKUs per organization, case-insensitively, but not across organizations", async () => {
    const a = await register("sku-a");
    const b = await register("sku-b");
    expect((await createItem(a.token, { sku: "Abc-1" })).status).toBe(201);
    const dup = await createItem(a.token, { sku: "ABC-1" });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("CONFLICT");
    expect((await createItem(b.token, { sku: "Abc-1" })).status).toBe(201);
  });
});

describe("categories", () => {
  it("creates, renames, disables; disabled or foreign categories cannot be assigned; filter by category works", async () => {
    const a = await register("cat-a");
    const b = await register("cat-b");
    const cat = await api.call("POST", "/catalog/categories", { token: a.token, body: { name: "Hardware" } });
    expect(cat.status).toBe(201);
    expect((await api.call("POST", "/catalog/categories", { token: a.token, body: { name: "HARDWARE" } })).status).toBe(409);
    expect((await api.call("POST", "/catalog/categories", { token: b.token, body: { name: "Hardware" } })).status).toBe(201);
    expect((await api.call("PATCH", `/catalog/categories/${cat.body.id}`, { token: a.token, body: { name: "Hardware & Parts" } })).body.name).toBe("Hardware & Parts");

    const item = await createItem(a.token, { categoryId: cat.body.id });
    expect(item.body.draft.categoryId).toBe(cat.body.id);
    await createItem(a.token);
    const filtered = await api.call("GET", `/catalog/items?categoryId=${cat.body.id}`, { token: a.token });
    expect(filtered.body.items.map((i: { id: string }) => i.id)).toEqual([item.body.id]);

    const bCat = (await api.call("GET", "/catalog/categories", { token: b.token })).body[0].id;
    expect((await createItem(a.token, { categoryId: bCat })).status).toBe(400); // foreign id is indistinguishable from unknown
    await api.call("PATCH", `/catalog/categories/${cat.body.id}`, { token: a.token, body: { status: "disabled" } });
    expect((await createItem(a.token, { categoryId: cat.body.id })).status).toBe(400);
    expect((await api.call("PATCH", `/catalog/categories/${cat.body.id}`, { token: a.token, body: {} })).status).toBe(400);
    expect((await api.call("GET", "/catalog/categories", { token: a.token })).body).toHaveLength(1);
  });
});

describe("pagination", () => {
  it("walks all items by keyset cursor without gaps or duplicates and rejects bad cursors", async () => {
    const a = await register("page");
    const skus = ["p-1", "p-2", "p-3", "p-4", "p-5"];
    for (const s of [...skus].reverse()) await createItem(a.token, { sku: s });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const res = await api.call("GET", `/catalog/items?limit=2${cursor ? `&cursor=${cursor}` : ""}`, { token: a.token });
      seen.push(...res.body.items.map((x: { sku: string }) => x.sku));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(skus);
    for (const bad of ["UPPER", "has space", "x".repeat(65)]) expect((await api.call("GET", `/catalog/items?cursor=${encodeURIComponent(bad)}`, { token: a.token })).status).toBe(400);
    expect((await api.call("GET", "/catalog/items?limit=101", { token: a.token })).status).toBe(400);
    expect((await api.call("GET", "/catalog/items?status=bogus", { token: a.token })).status).toBe(400);
  });
});

describe("RBAC matrix", () => {
  const expected: Record<MembershipRole, { read: number; manage: number; approve: number }> = {
    org_admin: { read: 200, manage: 201, approve: 200 },
    sales_manager: { read: 200, manage: 201, approve: 403 },
    campaign_manager: { read: 200, manage: 403, approve: 403 },
    seller: { read: 200, manage: 403, approve: 403 },
    analyst: { read: 200, manage: 403, approve: 403 },
    viewer: { read: 200, manage: 403, approve: 403 },
  };
  it("covers every role", () => expect(Object.keys(expected).sort()).toEqual([...MEMBERSHIP_ROLES].sort()));

  it.each(MEMBERSHIP_ROLES)("%s gets exactly its catalog permissions", async (role) => {
    const a = await register(`rbac-${role}`);
    const draftId = (await createItem(a.token)).body.id as string;
    const token = role === "org_admin" ? a.token : (await member(a.orgId, role)).token;
    const e = expected[role];
    expect((await api.call("GET", "/catalog/items", { token })).status).toBe(e.read);
    expect((await api.call("GET", "/catalog/categories", { token })).status).toBe(e.read);
    expect((await api.call("POST", "/catalog/categories", { token, body: { name: `c-${role}` } })).status).toBe(e.manage);
    expect((await createItem(token)).status).toBe(e.manage);
    expect((await api.call("PATCH", `/catalog/items/${draftId}`, { token, body: { name: `by ${role}` } })).status).toBe(e.manage === 201 ? 200 : 403);
    expect((await act(token, draftId, "approve")).status).toBe(e.approve);
    const approvedNow = e.approve === 200;
    expect((await act(token, draftId, "archive")).status).toBe(e.approve);
    expect((await act(token, draftId, "restore")).status).toBe(approvedNow ? 200 : 403);
  });
});

describe("tenant isolation", () => {
  it("tenant B cannot see or act on tenant A's items, and DB-level RLS agrees", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    const id = (await createItem(a.token, { sku: "shared-sku" })).body.id as string;
    await act(a.token, id, "approve");

    expect((await api.call("GET", "/catalog/items", { token: b.token })).body.items).toEqual([]);
    expect((await api.call("GET", `/catalog/items/${id}`, { token: b.token })).status).toBe(404);
    expect((await api.call("GET", `/catalog/items/${id}/versions`, { token: b.token })).status).toBe(404);
    expect((await api.call("PATCH", `/catalog/items/${id}`, { token: b.token, body: { name: "pwned" } })).status).toBe(404);
    for (const action of ["versions", "approve", "archive", "restore"]) {
      expect((await api.call("POST", `/catalog/items/${id}/${action}`, { token: b.token })).status).toBe(404);
    }
    expect((await createItem(b.token, { sku: "shared-sku" })).status).toBe(201); // SKU namespace is per tenant
    expect((await owner.query("SELECT archived_at FROM catalog_items WHERE id = $1", [id])).rows[0].archived_at).toBeNull();

    const ctx = ctxOf(b, "org_admin");
    await asRuntime(ctx, async (c) => {
      expect((await c.query("SELECT 1 FROM catalog_items WHERE id = $1", [id])).rowCount).toBe(0);
      expect((await c.query("SELECT 1 FROM catalog_item_versions WHERE item_id = $1", [id])).rowCount).toBe(0);
      expect((await c.query("UPDATE catalog_items SET latest_version = 99 WHERE id = $1", [id])).rowCount).toBe(0);
    });
    expect(await denied(ctx, "INSERT INTO catalog_items (organization_id, kind, sku, sku_key, created_by, updated_at) VALUES ($1,'product','x','x',$2, now())", [a.orgId, b.userId])).toMatch(/row-level security/);
    expect(await denied(ctx, "UPDATE catalog_items SET organization_id = $1 WHERE id = $2", [a.orgId, id])).toMatch(/permission denied/);
  });
});

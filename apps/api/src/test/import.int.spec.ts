import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMBERSHIP_ROLES, type MembershipRole } from "@prospecting/contracts";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** P3-04: CSV import - dry run, all-or-nothing apply, idempotency, drafts only, row errors, RBAC, isolation. */
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
const imp = (t: string, mode: "dry_run" | "apply", csv: string, headers: Record<string, string> = {}) =>
  api.call("POST", "/catalog/imports", { token: t, body: { mode, csv }, headers });
const itemCount = async (orgId: string) => Number((await owner.query("SELECT count(*) AS n FROM catalog_items WHERE organization_id = $1", [orgId])).rows[0].n);
const bySku = async (t: string, sku: string) => (await api.call("GET", `/catalog/items?limit=100`, { token: t })).body.items.find((i: { sku: string }) => i.sku === sku);
const s = (p: string) => `${p}-${randomUUID().slice(0, 6)}`;

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("dry run", () => {
  it("validates and reports what would happen without changing anything or auditing", async () => {
    const a = await register("dry");
    const sku1 = s("D1");
    const csv = `sku,kind,name,description\n${sku1},product,Widget,Nice\n${s("D2")},service,Install,\n`;
    const res = await imp(a.token, "dry_run", csv);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "dry_run", status: "valid", totals: { rows: 2, created: 2, updated: 0, unchanged: 0, errors: 0 }, errorsTruncated: false });
    expect(res.body.rows.map((r: { action: string }) => r.action)).toEqual(["create", "create"]);
    expect(res.body.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await itemCount(a.orgId)).toBe(0);
    const actions = (await api.call("GET", "/audit-events?limit=100", { token: a.token })).body.map((e: { action: string }) => e.action);
    expect(actions.filter((x: string) => x.startsWith("catalog."))).toEqual([]);
    expect((await api.call("GET", "/catalog/imports", { token: a.token })).body.items).toHaveLength(1);
  });
});

describe("apply", () => {
  it("creates DRAFT items only (never approved), records the job and audits the import", async () => {
    const a = await register("apply");
    const [k1, k2] = [s("A1"), s("A2")];
    const category = (await api.call("POST", "/catalog/categories", { token: a.token, body: { name: "Hardware" } })).body.id;
    const csv = `sku,kind,name,description,unit,category,feature:Color,feature:Weight\n${k1},product,Widget,Nice,pcs,hardware,Red,2kg\n${k2},SERVICE,Install,,,,,\n`;
    const res = await imp(a.token, "apply", csv);
    expect(res.body).toMatchObject({ mode: "apply", status: "applied", totals: { rows: 2, created: 2, errors: 0 } });
    const first = await bySku(a.token, k1);
    expect(first).toMatchObject({ status: "draft", approved: null, kind: "product", draft: { name: "Widget", description: "Nice", unit: "pcs", categoryId: category } });
    expect(first.draft.features).toEqual([{ name: "Color", value: "Red" }, { name: "Weight", value: "2kg" }]);
    expect((await bySku(a.token, k2)).kind).toBe("service");
    const events = (await api.call("GET", "/audit-events?limit=100", { token: a.token })).body as Array<{ action: string; metadata: Record<string, unknown> }>;
    expect(events.find((e) => e.action === "catalog.import_applied")?.metadata).toMatchObject({ created: 2, updated: 0, unchanged: 0, errors: 0 });
    const job = await api.call("GET", `/catalog/imports/${res.body.id}`, { token: a.token });
    expect(job.body).toMatchObject({ id: res.body.id, status: "applied", fileHash: res.body.fileHash });
  });

  it("is idempotent: importing the same file again changes nothing", async () => {
    const a = await register("idem");
    const csv = `sku,kind,name\n${s("I1")},product,One\n${s("I2")},product,Two\n`;
    expect((await imp(a.token, "apply", csv)).body.totals).toMatchObject({ created: 2 });
    const again = await imp(a.token, "apply", csv);
    expect(again.body).toMatchObject({ status: "applied", totals: { created: 0, updated: 0, unchanged: 2 } });
    expect((await owner.query("SELECT count(*)::int AS n FROM catalog_item_versions WHERE organization_id = $1", [a.orgId])).rows[0].n).toBe(2);
    expect(await itemCount(a.orgId)).toBe(2);
  });

  it("honours Idempotency-Key (replays the stored result, no second job)", async () => {
    const a = await register("idem-key");
    const csv = `sku,kind,name\n${s("K1")},product,One\n`;
    const key = `import-${randomUUID()}`;
    const first = await imp(a.token, "apply", csv, { "idempotency-key": key });
    const second = await imp(a.token, "apply", csv, { "idempotency-key": key });
    expect(second.body).toEqual(first.body);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect((await api.call("GET", "/catalog/imports", { token: a.token })).body.items).toHaveLength(1);
    expect((await imp(a.token, "dry_run", csv, { "idempotency-key": key })).status).toBe(422);
  });

  it("updates through drafts: approved content stays until someone approves; re-import is a no-op; a further change edits the open draft", async () => {
    const a = await register("update");
    const sku = s("U1");
    await imp(a.token, "apply", `sku,kind,name,description\n${sku},product,Original,keep me\n`);
    const id = (await bySku(a.token, sku)).id;
    await api.call("POST", `/catalog/items/${id}/approve`, { token: a.token });

    const changed = await imp(a.token, "apply", `sku,kind,name,description\n${sku},product,Renamed,keep me\n`);
    expect(changed.body.totals).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
    let item = await bySku(a.token, sku);
    expect(item).toMatchObject({ status: "approved", latestVersion: 2, approved: { version: 1, name: "Original" }, draft: { version: 2, name: "Renamed" } });

    expect((await imp(a.token, "apply", `sku,kind,name,description\n${sku},product,Renamed,keep me\n`)).body.totals).toMatchObject({ updated: 0, unchanged: 1 });
    await imp(a.token, "apply", `sku,kind,name,description\n${sku},product,Renamed again,keep me\n`);
    item = await bySku(a.token, sku);
    expect(item).toMatchObject({ latestVersion: 2, approved: { name: "Original" }, draft: { version: 2, name: "Renamed again" } });
  });

  it("only touches the columns present in the file; an empty cell in a present column clears it", async () => {
    const a = await register("managed");
    const sku = s("M1");
    await imp(a.token, "apply", `sku,kind,name,description,unit,feature:Color\n${sku},product,Thing,desc,pcs,Red\n`);
    await imp(a.token, "apply", `sku,kind,name\n${sku},product,Thing 2\n`); // only name is managed
    expect((await bySku(a.token, sku)).draft).toMatchObject({ name: "Thing 2", description: "desc", unit: "pcs", features: [{ name: "Color", value: "Red" }] });
    await imp(a.token, "apply", `sku,kind,name,description,feature:Color\n${sku},product,Thing 2,,\n`); // present but empty => cleared
    expect((await bySku(a.token, sku)).draft).toMatchObject({ description: null, unit: "pcs", features: [] });
  });

  it("is atomic: one bad row rejects the whole apply and writes no items", async () => {
    const a = await register("atomic");
    const csv = `sku,kind,name\n${s("G1")},product,Good\nbad sku!,product,Bad\n${s("G3")},product,Good too\n`;
    const dry = await imp(a.token, "dry_run", csv);
    expect(dry.body).toMatchObject({ status: "invalid", totals: { rows: 3, errors: 1 } });
    const res = await imp(a.token, "apply", csv);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "rejected", totals: { created: 0, updated: 0, unchanged: 0, errors: 1 } });
    expect(res.body.errors[0]).toMatchObject({ row: 3, column: "sku", sku: "bad sku!" });
    expect(res.body.rows.map((r: { action: string }) => r.action)).toEqual(["create", "error", "create"]);
    expect(await itemCount(a.orgId)).toBe(0);
    const events = (await api.call("GET", "/audit-events?limit=100", { token: a.token })).body.map((e: { action: string }) => e.action);
    expect(events).toContain("catalog.import_rejected");
  });

  it("applies a few hundred rows well inside the time budget", async () => {
    const a = await register("bulk");
    const rows = Array.from({ length: 300 }, (_, i) => `BULK-${String(i).padStart(4, "0")},product,Item ${i}`).join("\n");
    const started = Date.now();
    const res = await imp(a.token, "apply", `sku,kind,name\n${rows}\n`);
    expect(res.body).toMatchObject({ status: "applied", totals: { created: 300 } });
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(await itemCount(a.orgId)).toBe(300);
  }, 90_000);

  it("concurrent identical imports never duplicate items: one wins, the other is told to retry or sees no changes", async () => {
    const a = await register("race");
    const csv = `sku,kind,name\n${s("R1")},product,One\n${s("R2")},product,Two\n`;
    const results = await Promise.all([imp(a.token, "apply", csv), imp(a.token, "apply", csv)]);
    expect(results.some((r) => r.status === 200 && r.body.totals.created === 2)).toBe(true);
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(await itemCount(a.orgId)).toBe(2);
  });
});

describe("row errors", () => {
  it("reports precise, non-echoing errors per row", async () => {
    const a = await register("rowerr");
    await imp(a.token, "apply", `sku,kind,name\nEXIST-1,product,Existing\nARCH-1,product,To archive\n`);
    const archived = (await bySku(a.token, "ARCH-1")).id;
    await api.call("POST", `/catalog/items/${archived}/archive`, { token: a.token });
    const disabled = (await api.call("POST", "/catalog/categories", { token: a.token, body: { name: "Old" } })).body.id;
    await api.call("PATCH", `/catalog/categories/${disabled}`, { token: a.token, body: { status: "disabled" } });

    const csv = [
      "sku,kind,name,category",
      "OK-1,product,Fine,",
      "BAD KIND,gadget,x,",
      "NONAME-1,product,,",
      "OK-1,product,Dup,",
      "EXIST-1,service,Wrong kind,",
      "ARCH-1,product,Edit archived,",
      "CAT-1,product,Ghost category,Nope",
      "CAT-2,product,Disabled category,old",
      "SHORT-1,product",
    ].join("\n");
    const res = await imp(a.token, "dry_run", csv);
    expect(res.body.status).toBe("invalid");
    const byRow = new Map<number, string[]>(res.body.errors.map((e: { row: number; code: string }) => [e.row, [] as string[]]));
    for (const e of res.body.errors as Array<{ row: number; code: string }>) byRow.get(e.row)!.push(e.code);
    expect(byRow.get(3)).toEqual(expect.arrayContaining(["invalid_value"])); // BAD KIND: invalid sku + invalid kind
    expect(byRow.get(4)).toBeDefined(); // empty name
    expect(byRow.get(5)).toEqual(["duplicate_in_file"]);
    expect(byRow.get(6)).toEqual(["kind_mismatch"]);
    expect(byRow.get(7)).toEqual(["item_archived"]);
    expect(byRow.get(8)).toEqual(["unknown_category"]);
    expect(byRow.get(9)).toEqual(["unknown_category"]); // disabled counts as unknown
    expect(byRow.get(10)).toEqual(["column_count"]);
    expect(byRow.has(2)).toBe(false);
    expect(res.body.rows.find((r: { row: number }) => r.row === 2).action).toBe("create");
    expect(JSON.stringify(res.body.errors)).not.toContain("Ghost category"); // messages never echo cell values
  });

  it("caps the reported errors but keeps the full count", async () => {
    const a = await register("cap");
    const rows = Array.from({ length: 150 }, (_, i) => `bad sku ${i},product,x`).join("\n");
    const res = await imp(a.token, "dry_run", `sku,kind,name\n${rows}\n`);
    expect(res.body.totals.errors).toBe(150);
    expect(res.body.errors).toHaveLength(100);
    expect(res.body.errorsTruncated).toBe(true);
  });
});

describe("file-level rejection (400, nothing recorded)", () => {
  const bad: Array<[string, string, string]> = [
    ["missing required column", "sku,name\nA,B\n", "missing_column"],
    ["unknown column", "sku,kind,name,price\nA,product,B,10\n", "unknown_column"],
    ["price is not importable yet", "sku,kind,name,unit_price\nA,product,B,10\n", "unknown_column"],
    ["duplicate column", "sku,kind,name,NAME\nA,product,B,C\n", "duplicate_column"],
    ["no data rows", "sku,kind,name\n", "no_data_rows"],
    ["unterminated quote", 'sku,kind,name\nA,product,"B\n', "unterminated_quote"],
    ["stray quote", 'sku,kind,name\nA,product,B"C\n', "stray_quote"],
    ["NUL byte", "sku,kind,name\nA,product,B\u0000\n", "control_character"],
    ["empty feature name", "sku,kind,name,feature:\nA,product,B,x\n", "invalid_column"],
    ["only blank lines", "\n\n\n", "empty"],
  ];
  it.each(bad)("%s", async (_n, csv, code) => {
    const a = await register("file");
    const res = await imp(a.token, "apply", csv);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.details.issues[0]).toMatchObject({ path: "csv", code });
    expect((await api.call("GET", "/catalog/imports", { token: a.token })).body.items).toEqual([]);
  });

  it("rejects too many rows, oversize payloads and unknown fields", async () => {
    const a = await register("limits");
    const many = Array.from({ length: 1001 }, (_, i) => `S${i},product,n`).join("\n");
    expect((await imp(a.token, "apply", `sku,kind,name\n${many}\n`)).body.details.issues[0].code).toBe("too_many_rows");
    expect((await imp(a.token, "dry_run", "x".repeat(1_000_001))).status).toBe(400); // schema limit
    expect((await imp(a.token, "dry_run", "x".repeat(2_000_000))).status).toBe(413); // body limit
    expect((await api.call("POST", "/catalog/imports", { token: a.token, body: { mode: "apply", csv: "a", organization_id: randomUUID() } })).status).toBe(400);
    expect((await api.call("POST", "/catalog/imports", { token: a.token, body: { mode: "delete", csv: "a" } })).status).toBe(400);
  });
});

describe("RBAC and isolation", () => {
  const allowed: MembershipRole[] = ["org_admin", "sales_manager"];
  it.each(MEMBERSHIP_ROLES)("%s", async (role) => {
    const a = await register(`rbac-${role}`);
    const token = role === "org_admin" ? a.token : await member(a.orgId, role);
    const ok = allowed.includes(role);
    const res = await imp(token, "apply", `sku,kind,name\n${s("P")},product,By ${role}\n`);
    expect(res.status).toBe(ok ? 200 : 403);
    expect((await api.call("GET", "/catalog/imports", { token })).status).toBe(ok ? 200 : 403);
    expect(await itemCount(a.orgId)).toBe(ok ? 1 : 0);
    if (ok) expect((await api.call("GET", "/catalog/items", { token })).body.items[0].status).toBe("draft"); // imports can never approve
  });

  it("tenant B cannot see A's jobs; the same file creates B's own items; RLS agrees", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    const csv = `sku,kind,name\nSHARED-1,product,Shared\n`;
    const job = await imp(a.token, "apply", csv);
    expect((await api.call("GET", "/catalog/imports", { token: b.token })).body.items).toEqual([]);
    expect((await api.call("GET", `/catalog/imports/${job.body.id}`, { token: b.token })).status).toBe(404);
    expect((await imp(b.token, "apply", csv)).body.totals.created).toBe(1);
    expect(await itemCount(a.orgId)).toBe(1);
    expect(await itemCount(b.orgId)).toBe(1);

    const viewerCtx = { organizationId: a.orgId, userId: a.userId, role: "viewer" };
    await asRuntime(viewerCtx, async (c) => expect((await c.query("SELECT 1 FROM import_jobs")).rowCount).toBe(0)); // policy needs a catalog manager
    const denied = (sql: string) => asRuntime({ ...viewerCtx, role: "org_admin", organizationId: b.orgId, userId: b.userId }, async (c) => c.query(sql).then(() => "NO ERROR", (e: Error) => e.message));
    expect(await denied("UPDATE import_jobs SET status = 'applied'")).toMatch(/permission denied/);
    expect(await denied("DELETE FROM import_jobs")).toMatch(/permission denied/);
  });
});

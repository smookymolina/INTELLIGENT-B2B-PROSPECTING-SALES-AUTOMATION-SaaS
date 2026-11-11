import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMBERSHIP_ROLES, normalizeDomain, type MembershipRole } from "@prospecting/contracts";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** P4-01: prospects, provenance, dedupe, do-not-contact list, CSV import, RBAC, isolation. */
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
  const token = (await api.call("POST", "/auth/login", { body: { email: m.email, password: PASSWORD } })).body.token as string;
  return { token, userId: m.userId };
}
const dom = () => `acme-${randomUUID().slice(0, 8)}.example`;
const create = (t: string, body: Record<string, unknown>) => api.call("POST", "/prospects", { token: t, body });
const setStatus = (t: string, id: string, status: string, reason?: string) => api.call("POST", `/prospects/${id}/status`, { token: t, body: { status, ...(reason ? { reason } : {}) } });
const suppress = (t: string, kind: string, value: string, reason = "requested opt-out") => api.call("POST", "/suppressions", { token: t, body: { kind, value, reason } });
const imp = (t: string, mode: string, csv: string) => api.call("POST", "/prospects/imports", { token: t, body: { mode, csv } });
const count = async (orgId: string) => Number((await owner.query("SELECT count(*) AS n FROM prospects WHERE organization_id = $1", [orgId])).rows[0].n);

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("normalizeDomain", () => {
  it("reduces URLs to a bare domain and rejects anything else", () => {
    expect(normalizeDomain("https://www.Example.COM:8080/a/b?x=1#y")).toBe("example.com");
    expect(normalizeDomain("  sub.shop.example.co.uk. ")).toBe("sub.shop.example.co.uk");
    for (const bad of ["", "localhost", "a@b.com", "192.168.0.1", "exa mple.com", "-bad.com", "bad-.com", "ejemplo.mx‮", "münchen.de", "x".repeat(64) + ".com"]) expect(normalizeDomain(bad)).toBeNull();
  });
});

describe("prospects", () => {
  it("creates a candidate with manual provenance and no contact permission", async () => {
    const a = await register("create");
    const res = await create(a.token, { name: "  Acme   Logística ", domain: "https://www.ACME-Test.example/contacto", country: "MX", city: "Monterrey", industry: "Logística" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Acme   Logística", domain: "acme-test.example", country: "MX", status: "candidate", suppressed: false, contactPermission: "none", statusReason: null });
    const detail = await api.call("GET", `/prospects/${res.body.id}`, { token: a.token });
    expect(detail.body.sources).toEqual([expect.objectContaining({ type: "manual", ref: null, createdBy: a.userId })]);
    expect((await api.call("GET", "/prospects/connectors", { token: a.token })).body).toMatchObject({ connectors: [] });
  });

  it("deduplicates by domain, or by name+country when there is no domain", async () => {
    const a = await register("dedupe");
    const d = dom();
    const first = await create(a.token, { name: "One", domain: d });
    const dup = await create(a.token, { name: "Totally different name", domain: `HTTP://WWW.${d.toUpperCase()}/x` });
    expect(dup.status).toBe(409);
    expect(dup.body.details).toEqual({ existingId: first.body.id });
    const n1 = await create(a.token, { name: "Sin Dominio SA", country: "MX" });
    expect((await create(a.token, { name: "sin   dominio sa", country: "MX" })).body.details.existingId).toBe(n1.body.id);
    expect((await create(a.token, { name: "Sin Dominio SA", country: "CO" })).status).toBe(201);
    expect((await create(a.token, { name: "Sin Dominio SA" })).status).toBe(201);
    expect(await count(a.orgId)).toBe(4);
  });

  it("validates input strictly", async () => {
    const a = await register("val");
    for (const body of [{}, { name: "" }, { name: "x", domain: "not a domain" }, { name: "x", domain: "a@b.com" }, { name: "x", country: "mx" }, { name: "x", status: "qualified" }, { name: "x", organization_id: randomUUID() }, { name: "x", contactPermission: "granted" }]) {
      expect((await create(a.token, body)).status).toBe(400);
    }
    expect(await count(a.orgId)).toBe(0);
  });

  it("updates re-key the record and keep dedupe intact", async () => {
    const a = await register("update");
    const p1 = await create(a.token, { name: "P1", domain: dom() });
    const p2 = await create(a.token, { name: "P2", domain: dom() });
    const moved = dom();
    const ok = await api.call("PATCH", `/prospects/${p1.body.id}`, { token: a.token, body: { domain: moved, city: "León", industry: null } });
    expect(ok.body).toMatchObject({ domain: moved, city: "León", industry: null });
    const clash = await api.call("PATCH", `/prospects/${p2.body.id}`, { token: a.token, body: { domain: `www.${moved}` } });
    expect(clash.status).toBe(409);
    expect(clash.body.details.existingId).toBe(p1.body.id);
    for (const body of [{}, { status: "qualified" }, { organizationId: randomUUID() }]) expect((await api.call("PATCH", `/prospects/${p1.body.id}`, { token: a.token, body })).status).toBe(400);
    expect((await api.call("PATCH", `/prospects/${randomUUID()}`, { token: a.token, body: { city: "x" } })).status).toBe(404);
  });

  it("qualifies, disqualifies with a reason, and clears the reason on return to candidate", async () => {
    const a = await register("status");
    const p = (await create(a.token, { name: "S", domain: dom() })).body.id as string;
    expect((await setStatus(a.token, p, "qualified")).body.status).toBe("qualified");
    const dis = await setStatus(a.token, p, "disqualified", "sin presupuesto");
    expect(dis.body).toMatchObject({ status: "disqualified", statusReason: "sin presupuesto" });
    expect((await setStatus(a.token, p, "candidate")).body).toMatchObject({ status: "candidate", statusReason: null });
    expect((await setStatus(a.token, p, "bogus")).status).toBe(400);
    const events = (await api.call("GET", "/audit-events?limit=100", { token: a.token })).body.map((e: { action: string }) => e.action);
    expect(events).toEqual(expect.arrayContaining(["prospect.created", "prospect.status_changed"]));
  });
});

describe("do-not-contact list", () => {
  it("a new entry disqualifies matching qualified prospects at once, flags them, and blocks qualification", async () => {
    const a = await register("supp");
    const d = dom();
    const p = (await create(a.token, { name: "Blocked Co", domain: d })).body.id as string;
    const other = (await create(a.token, { name: "Free Co", domain: dom() })).body.id as string;
    await setStatus(a.token, p, "qualified");
    await setStatus(a.token, other, "qualified");

    const entry = await suppress(a.token, "domain", `https://www.${d}/`);
    expect(entry.status).toBe(201);
    expect(entry.body).toMatchObject({ kind: "domain", value: d, reason: "requested opt-out" });
    const after = await api.call("GET", `/prospects/${p}`, { token: a.token });
    expect(after.body).toMatchObject({ status: "disqualified", statusReason: "suppressed", suppressed: true });
    expect((await api.call("GET", `/prospects/${other}`, { token: a.token })).body).toMatchObject({ status: "qualified", suppressed: false });
    expect((await setStatus(a.token, p, "qualified")).status).toBe(409);
    expect((await suppress(a.token, "domain", d)).status).toBe(409);

    const events = (await api.call("GET", "/audit-events?limit=100", { token: a.token })).body as Array<{ action: string; metadata: Record<string, unknown> }>;
    expect(events.find((e) => e.action === "suppression.created")?.metadata).toMatchObject({ kind: "domain", disqualifiedProspects: 1 });
  });

  it("supports name entries, filters and removal (org_admin only) which re-allows qualification", async () => {
    const a = await register("supp-name");
    const sm = await member(a.orgId, "sales_manager");
    const p = (await create(a.token, { name: "Nombre Vetado SA", country: "MX" })).body.id as string;
    const entry = await suppress(sm.token, "name", "  NOMBRE   vetado sa ");
    expect(entry.body.value).toBe("nombre vetado sa");
    expect((await api.call("GET", `/prospects/${p}`, { token: a.token })).body.suppressed).toBe(true);
    expect((await api.call("GET", "/prospects?suppressed=true", { token: a.token })).body.items.map((x: { id: string }) => x.id)).toEqual([p]);
    expect((await api.call("GET", "/prospects?suppressed=false", { token: a.token })).body.items).toEqual([]);

    expect((await api.call("DELETE", `/suppressions/${entry.body.id}`, { token: sm.token })).status).toBe(403);
    expect((await api.call("DELETE", `/suppressions/${entry.body.id}`, { token: a.token })).status).toBe(204);
    expect((await api.call("DELETE", `/suppressions/${entry.body.id}`, { token: a.token })).status).toBe(404);
    expect((await setStatus(a.token, p, "qualified")).body).toMatchObject({ status: "qualified", suppressed: false });
    expect((await api.call("GET", "/suppressions", { token: a.token })).body.items).toEqual([]);
    for (const body of [{ kind: "domain", value: "not a domain", reason: "x" }, { kind: "email", value: "a@b.com", reason: "x" }, { kind: "name", value: "x" }, { kind: "name", value: "x", reason: "" }]) {
      expect((await api.call("POST", "/suppressions", { token: a.token, body })).status).toBe(400);
    }
  });

  it("is enforced by the database even for direct SQL", async () => {
    const a = await register("supp-db");
    const d = dom();
    const p = (await create(a.token, { name: "DB Co", domain: d })).body.id as string;
    await suppress(a.token, "domain", d);
    const ctx = { organizationId: a.orgId, userId: a.userId, role: "org_admin" };
    const msg = await asRuntime(ctx, async (c) => c.query("UPDATE prospects SET status = 'qualified' WHERE id = $1", [p]).then(() => "NO ERROR", (e: Error) => e.message));
    expect(msg).toMatch(/suppressed prospect/);
    await expect(owner.query("UPDATE prospects SET status = 'qualified' WHERE id = $1", [p])).rejects.toThrow(/suppressed prospect/);
  });

  it("a suppressed prospect imported from CSV is created but flagged and cannot be qualified", async () => {
    const a = await register("supp-import");
    const d = dom();
    await suppress(a.token, "domain", d);
    const res = await imp(a.token, "apply", `name,domain\nVetada,${d}\n`);
    expect(res.body).toMatchObject({ status: "applied", totals: { created: 1 } });
    const list = (await api.call("GET", "/prospects", { token: a.token })).body.items;
    expect(list[0]).toMatchObject({ suppressed: true, status: "candidate" });
    expect((await setStatus(a.token, list[0].id, "qualified")).status).toBe(409);
  });
});

describe("listing", () => {
  it("filters by status, country and name/domain prefix and pages by cursor", async () => {
    const a = await register("list");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await create(a.token, { name: `Lista ${i}`, domain: `lista${i}-${randomUUID().slice(0, 4)}.example`, country: i % 2 ? "MX" : "CO" })).body.id);
    await setStatus(a.token, ids[0] as string, "qualified");
    expect((await api.call("GET", "/prospects?status=qualified", { token: a.token })).body.items.map((x: { id: string }) => x.id)).toEqual([ids[0]]);
    expect((await api.call("GET", "/prospects?country=MX", { token: a.token })).body.items).toHaveLength(2);
    expect((await api.call("GET", "/prospects?q=LISTA%203", { token: a.token })).body.items).toHaveLength(1);
    expect((await api.call("GET", "/prospects?q=lista1-", { token: a.token })).body.items).toHaveLength(1);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 6; guard++) {
      const page = await api.call("GET", `/prospects?limit=2${cursor ? `&cursor=${cursor}` : ""}`, { token: a.token });
      seen.push(...page.body.items.map((x: { id: string }) => x.id));
      cursor = page.body.nextCursor;
      if (!cursor) break;
    }
    expect([...seen].sort()).toEqual([...ids].sort());
    for (const q of ["status=nope", "country=mexico", "limit=0", "cursor=zzz", "suppressed=maybe", "extra=1"]) expect((await api.call("GET", `/prospects?${q}`, { token: a.token })).status).toBe(400);
  });
});

describe("CSV import", () => {
  it("dry-runs without effects, applies with csv_import provenance, and is idempotent", async () => {
    const a = await register("imp");
    const [d1, d2] = [dom(), dom()];
    const csv = `name,domain,country,region,city,industry\nUno,${d1},mx,NL,Monterrey,Logística\nDos SA,,CO,,Bogotá,\n`;
    const dry = await imp(a.token, "dry_run", csv);
    expect(dry.body).toMatchObject({ status: "valid", totals: { rows: 2, created: 2, errors: 0 } });
    expect(await count(a.orgId)).toBe(0);

    const applied = await imp(a.token, "apply", csv);
    expect(applied.body).toMatchObject({ status: "applied", totals: { created: 2, updated: 0, unchanged: 0 } });
    const items = (await api.call("GET", "/prospects", { token: a.token })).body.items as Array<{ id: string; name: string; status: string; country: string }>;
    expect(items.map((i) => [i.name, i.status, i.country]).sort()).toEqual([["Dos SA", "candidate", "CO"], ["Uno", "candidate", "MX"]]);
    const detail = await api.call("GET", `/prospects/${items.find((i) => i.name === "Uno")?.id}`, { token: a.token });
    expect(detail.body.sources).toEqual([expect.objectContaining({ type: "csv_import", ref: applied.body.id })]);

    expect((await imp(a.token, "apply", csv)).body).toMatchObject({ status: "applied", totals: { created: 0, updated: 0, unchanged: 2 } });
    const changed = await imp(a.token, "apply", `name,domain,city\nUno Renombrada,${d1},Guadalajara\n`);
    expect(changed.body.totals).toMatchObject({ updated: 1 });
    const uno = (await api.call("GET", "/prospects?q=" + d1, { token: a.token })).body.items[0];
    expect(uno).toMatchObject({ name: "Uno Renombrada", city: "Guadalajara", region: "NL", industry: "Logística" }); // only present columns change
    expect(d2).toBeTruthy();
    const jobs = await api.call("GET", "/prospects/imports", { token: a.token });
    expect(jobs.body.items).toHaveLength(4);
    expect((await api.call("GET", `/prospects/imports/${applied.body.id}`, { token: a.token })).body.status).toBe("applied");
    expect((await api.call("GET", "/catalog/imports", { token: a.token })).body.items).toEqual([]); // job lists are separated by kind
  });

  it("never changes status, and is all-or-nothing with precise row errors", async () => {
    const a = await register("imp-atomic");
    const d = dom();
    const p = (await create(a.token, { name: "Existing", domain: d })).body.id as string;
    await setStatus(a.token, p, "qualified");
    await imp(a.token, "apply", `name,domain\nRenamed,${d}\n`);
    expect((await api.call("GET", `/prospects/${p}`, { token: a.token })).body).toMatchObject({ name: "Renamed", status: "qualified" });

    const before = await count(a.orgId);
    const csv = `name,domain,country\nGood,${dom()},MX\n,${dom()},MX\nBad Domain,not a domain,MX\nDup,${d},MX\nDup again,${d},MX\nBad Country,${dom()},MEX\nShort\n`;
    const res = await imp(a.token, "apply", csv);
    expect(res.body.status).toBe("rejected");
    expect(res.body.totals).toMatchObject({ created: 0, errors: 5 });
    const byRow = new Map<number, string>(res.body.errors.map((e: { row: number; column: string }) => [e.row, e.column]));
    expect([...byRow.keys()]).toEqual([3, 4, 6, 7, 8].filter((r) => byRow.has(r)));
    expect(byRow.get(3)).toBe("name");
    expect(byRow.get(4)).toBe("domain");
    expect(res.body.errors.find((e: { row: number }) => e.row === 6)).toMatchObject({ code: "duplicate_in_file" });
    expect(await count(a.orgId)).toBe(before);
    expect(JSON.stringify(res.body.errors)).not.toContain("not a domain");
  });

  it("rejects bad files with 400 and records nothing", async () => {
    const a = await register("imp-file");
    for (const csv of ["domain\nx.example\n", "name,price\nA,1\n", "name,name\nA,B\n", "name\n", 'name\n"unterminated\n']) {
      const r = await imp(a.token, "apply", csv);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("VALIDATION_FAILED");
    }
    expect((await api.call("GET", "/prospects/imports", { token: a.token })).body.items).toEqual([]);
  });
});

describe("RBAC", () => {
  const expected: Record<MembershipRole, { read: number; manage: number; suppress: number; remove: number }> = {
    org_admin: { read: 200, manage: 201, suppress: 201, remove: 204 },
    sales_manager: { read: 200, manage: 201, suppress: 201, remove: 403 },
    campaign_manager: { read: 200, manage: 201, suppress: 201, remove: 403 },
    seller: { read: 200, manage: 201, suppress: 403, remove: 403 },
    analyst: { read: 200, manage: 403, suppress: 403, remove: 403 },
    viewer: { read: 200, manage: 403, suppress: 403, remove: 403 },
  };
  it("covers every role", () => expect(Object.keys(expected).sort()).toEqual([...MEMBERSHIP_ROLES].sort()));

  it.each(MEMBERSHIP_ROLES)("%s gets exactly its prospecting permissions", async (role) => {
    const a = await register(`rbac-${role}`);
    const token = role === "org_admin" ? a.token : (await member(a.orgId, role)).token;
    const seedProspect = (await create(role === "seller" ? token : a.token, { name: "Seed", domain: dom() })).body.id as string;
    const seedSupp = (await suppress(a.token, "name", "seed suppression")).body.id as string;
    const e = expected[role];
    expect((await api.call("GET", "/prospects", { token })).status).toBe(e.read);
    expect((await api.call("GET", `/prospects/${seedProspect}`, { token })).status).toBe(e.read);
    expect((await api.call("GET", "/suppressions", { token })).status).toBe(e.read);
    expect((await api.call("GET", "/prospects/connectors", { token })).status).toBe(e.read);
    expect((await create(token, { name: `By ${role}`, domain: dom() })).status).toBe(e.manage);
    expect((await api.call("PATCH", `/prospects/${seedProspect}`, { token, body: { city: "X" } })).status).toBe(e.manage === 201 ? 200 : 403);
    expect((await setStatus(token, seedProspect, "qualified")).status).toBe(e.manage === 201 ? 200 : 403);
    expect((await imp(token, "dry_run", `name\nX ${role}\n`)).status).toBe(e.manage === 201 ? 200 : 403);
    expect((await api.call("GET", "/prospects/imports", { token })).status).toBe(e.manage === 201 ? 200 : 403);
    expect((await suppress(token, "name", `by ${role}`)).status).toBe(e.suppress);
    expect((await api.call("DELETE", `/suppressions/${seedSupp}`, { token })).status).toBe(e.remove);
  });
});

describe("tenant isolation", () => {
  it("tenant B cannot read or change A's prospects, suppressions or imports; the same domain can exist in both", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    const d = dom();
    const p = (await create(a.token, { name: "A Co", domain: d })).body.id as string;
    const s = (await suppress(a.token, "domain", d)).body.id as string;
    const job = await imp(a.token, "apply", `name\nA Imported\n`);

    expect((await api.call("GET", "/prospects", { token: b.token })).body.items).toEqual([]);
    expect((await api.call("GET", "/suppressions", { token: b.token })).body.items).toEqual([]);
    for (const [method, path, body] of [
      ["GET", `/prospects/${p}`, undefined], ["PATCH", `/prospects/${p}`, { city: "x" }], ["POST", `/prospects/${p}/status`, { status: "qualified" }],
      ["DELETE", `/suppressions/${s}`, undefined], ["GET", `/prospects/imports/${job.body.id}`, undefined],
    ] as const) expect((await api.call(method, path, { token: b.token, ...(body ? { body } : {}) })).status).toBe(404);
    const mine = await create(b.token, { name: "B Co", domain: d });
    expect(mine.status).toBe(201);
    expect(mine.body.suppressed).toBe(false); // A's do-not-contact list does not leak into B

    const ctx = { organizationId: b.orgId, userId: b.userId, role: "org_admin" };
    const denied = (sql: string, params: unknown[] = []) => asRuntime(ctx, async (c) => c.query(sql, params).then(() => "NO ERROR", (e: Error) => e.message));
    await asRuntime(ctx, async (c) => {
      expect((await c.query("SELECT 1 FROM prospects WHERE id = $1", [p])).rowCount).toBe(0);
      expect((await c.query("SELECT 1 FROM suppressions WHERE id = $1", [s])).rowCount).toBe(0);
      expect((await c.query("UPDATE prospects SET city = 'x' WHERE id = $1", [p])).rowCount).toBe(0);
      expect((await c.query("DELETE FROM suppressions WHERE id = $1", [s])).rowCount).toBe(0);
    });
    expect(await denied("INSERT INTO prospects (organization_id, name, name_key, dedupe_key, created_by, updated_at) VALUES ($1,'x','x','x|',$2, now())", [a.orgId, b.userId])).toMatch(/row-level security/);
    expect(await denied("INSERT INTO prospect_sources (organization_id, prospect_id, source_type, created_by) VALUES ($1,$2,'manual',$3)", [b.orgId, p, b.userId])).toMatch(/foreign key|row-level security/);
    expect(await denied("UPDATE prospect_sources SET source_ref = 'x'")).toMatch(/permission denied/);
    expect(await denied("DELETE FROM prospect_sources")).toMatch(/permission denied/);
    expect(await denied("DELETE FROM prospects")).toMatch(/permission denied/);
    expect(await denied("UPDATE prospects SET dedupe_key = 'broken' WHERE id = $1", [mine.body.id])).toMatch(/violates check constraint/);
    expect(await denied("UPDATE prospects SET organization_id = $1 WHERE id = $2", [a.orgId, mine.body.id])).toMatch(/permission denied/);
  });
});

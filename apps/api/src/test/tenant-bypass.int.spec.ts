import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/**
 * Negative tenant-isolation tests: two organizations, and every attempt by B to read or write A's data must end in
 * 400/401/403/404 with no trace of A's data in the response. Complements rls.int.spec.ts (database proofs) and tenancy.int.spec.ts.
 */
let api: Api;
type Tenant = { token: string; orgId: string; slug: string; userId: string; membershipId: string; prospectId: string; itemId: string };

async function register(label: string): Promise<Tenant> {
  const id = randomUUID().slice(0, 8);
  const res = await api.call("POST", "/auth/register", {
    body: { email: `${label}-${id}@example.test`, password: PASSWORD, displayName: label, organizationName: `Org ${label} ${id}` },
  });
  expect(res.status).toBe(201);
  const token = res.body.token as string;
  const me = await api.call("GET", "/me", { token });
  const members = await api.call("GET", "/memberships", { token });
  const prospect = await api.call("POST", "/prospects", { token, body: { name: `SECRETO-${label}-${id}`, domain: `${label}-${id}.example` } });
  expect(prospect.status).toBe(201);
  const item = await api.call("POST", "/catalog/items", { token, body: { kind: "product", sku: `S-${id}`, name: `ITEM-SECRETO-${label}-${id}` } });
  expect(item.status).toBe(201);
  return { token, orgId: res.body.organization.id, slug: res.body.organization.slug, userId: me.body.user.id, membershipId: members.body[0].id, prospectId: prospect.body.id, itemId: item.body.id };
}

const SAFE = new Set([400, 401, 403, 404, 409, 422]);
const dbOrgOf = async (table: string, id: string) => (await owner.query(`SELECT organization_id FROM ${table} WHERE id = $1`, [id])).rows[0]?.organization_id as string | undefined;

let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  api = await startApi();
  A = await register("bypass-a");
  B = await register("bypass-b");
});
afterAll(async () => {
  await api.close();
});

describe("(a) organization_id in the body is never trusted", () => {
  for (const key of ["organization_id", "organizationId", "org_id", "tenant_id"]) {
    it(`create with ${key} of another organization is rejected and writes nothing`, async () => {
      const name = `INTRUSO-${randomUUID().slice(0, 8)}`;
      const res = await api.call("POST", "/prospects", { token: B.token, body: { name, domain: `x-${randomUUID().slice(0, 8)}.example`, [key]: A.orgId } });
      expect(res.status).toBe(400);
      expect((await owner.query("SELECT 1 FROM prospects WHERE name = $1", [name])).rowCount).toBe(0);
    });
    it(`update with ${key} cannot move a resource across organizations`, async () => {
      const res = await api.call("PATCH", `/prospects/${B.prospectId}`, { token: B.token, body: { name: "Renombrado", [key]: A.orgId } });
      expect(res.status).toBe(400);
      expect(await dbOrgOf("prospects", B.prospectId)).toBe(B.orgId);
    });
  }
  it("a catalog item cannot be created or updated into another organization", async () => {
    const create = await api.call("POST", "/catalog/items", { token: B.token, body: { kind: "product", sku: `X-${randomUUID().slice(0, 6)}`, name: "Z", organization_id: A.orgId } });
    expect(create.status).toBe(400);
    const update = await api.call("PATCH", `/catalog/items/${B.itemId}`, { token: B.token, body: { organization_id: A.orgId } });
    expect(update.status).toBe(400);
    expect(await dbOrgOf("catalog_items", B.itemId)).toBe(B.orgId);
  });
});

describe("(b) query string cannot select another organization", () => {
  it("ignores or rejects organization selectors and never returns A's data", async () => {
    for (const q of [`organization_id=${A.orgId}`, `organizationId=${A.orgId}`, `orgId=${A.orgId}`, `tenant=${A.slug}`, `organization=${A.slug}`]) {
      for (const path of ["/prospects", "/catalog/items", "/memberships", "/audit-events", "/campaigns", "/opportunities"]) {
        const res = await api.call("GET", `${path}?${q}`, { token: B.token });
        expect([200, 400]).toContain(res.status);
        const text = JSON.stringify(res.body);
        expect(text).not.toContain("SECRETO-bypass-a");
        expect(text).not.toContain(A.orgId);
      }
    }
  });
});

describe("(c) headers cannot select another organization", () => {
  it("X-Organization-Id, X-Tenant & co. have no effect", async () => {
    const headers = { "x-organization-id": A.orgId, "x-org-id": A.orgId, "x-tenant": A.slug, "x-tenant-id": A.orgId, "x-organization": A.slug, "x-forwarded-host": `${A.slug}.example.test`, forwarded: `for=1.2.3.4;host=${A.slug}` };
    const list = await api.call("GET", "/prospects", { token: B.token, headers });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain("SECRETO-bypass-a");
    expect((await api.call("GET", `/prospects/${A.prospectId}`, { token: B.token, headers })).status).toBe(404);
    expect((await api.call("GET", "/organization", { token: B.token, headers })).body.id).toBe(B.orgId);
    const anon = await api.call("GET", "/prospects", { headers });
    expect(anon.status).toBe(401);
  });
});

describe("(d) IDOR: B uses A's resource ids on every route with a parameter", () => {
  type Route = { method: string; path: string };
  const routes = (): Route[] => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stack = (api.app.getHttpAdapter().getInstance() as any).router.stack as any[];
    const out: Route[] = [];
    for (const layer of stack) {
      const route = layer.route;
      if (!route || typeof route.path !== "string") continue;
      for (const m of Object.keys(route.methods ?? {})) if (["get", "put", "post", "patch", "delete"].includes(m)) out.push({ method: m.toUpperCase(), path: route.path });
    }
    return out;
  };

  /** One id per table, taken from rows that do NOT belong to B (A plus every organization left by earlier specs). */
  async function foreignIds(): Promise<string[]> {
    const tables = (
      await owner.query(`SELECT c.table_name FROM information_schema.columns c JOIN information_schema.columns o ON o.table_name = c.table_name AND o.table_schema = c.table_schema
        WHERE c.table_schema='public' AND c.column_name='id' AND o.column_name='organization_id' AND c.table_name <> '_prisma_migrations'`)
    ).rows.map((r) => r.table_name as string);
    const ids = new Set<string>([A.prospectId, A.itemId, A.membershipId, A.userId, A.orgId]);
    for (const t of tables) {
      const { rows } = await owner.query(`SELECT id::text FROM ${t} WHERE organization_id <> $1 ORDER BY (organization_id = $2) DESC LIMIT 1`, [B.orgId, A.orgId]);
      for (const r of rows) ids.add(r.id as string);
    }
    return [...ids];
  }

  it("never answers 2xx and never leaks A's data (all methods, all modules)", async () => {
    const ids = await foreignIds();
    const all = routes().filter((r) => r.path.includes(":"));
    const swept = all.filter((r) => !/:(token|slug|code)\b/.test(r.path) && !r.path.includes("/public/") && !r.path.startsWith("/v1/auth/"));
    expect(swept.length).toBeGreaterThan(40);
    const bodies: Record<string, unknown> = { PUT: {}, POST: {}, PATCH: {}, DELETE: undefined, GET: undefined };
    const offenders: string[] = [];
    let requests = 0;
    for (const r of swept) {
      for (const id of ids) {
        const path = r.path.replace(/^\/v1/, "").replace(/:[A-Za-z]+/g, id);
        const res = await api.call(r.method, path, { token: B.token, ...(bodies[r.method] !== undefined ? { body: bodies[r.method] } : {}) });
        requests += 1;
        const text = JSON.stringify(res.body ?? "");
        // 503 = no email provider configured: raised before any data access, identical for any id.
        const unavailable = res.status === 503 && r.method === "POST" && r.path.endsWith("/dispatch");
        if (!(SAFE.has(res.status) || unavailable) || text.includes("SECRETO-bypass-a") || text.includes(A.orgId)) offenders.push(`${r.method} ${path} -> ${res.status}`);
        if (offenders.length > 10) break;
      }
    }
    expect(requests).toBeGreaterThan(500);
    expect(offenders).toEqual([]);
    // A's data is untouched by the sweep.
    expect(await dbOrgOf("prospects", A.prospectId)).toBe(A.orgId);
    expect(await dbOrgOf("catalog_items", A.itemId)).toBe(A.orgId);
    expect((await api.call("GET", `/prospects/${A.prospectId}`, { token: A.token })).status).toBe(200);
  }, 600_000);

  it("positive control: the owner reads its own resources, B gets the same shape of request refused", async () => {
    expect((await api.call("GET", `/prospects/${A.prospectId}`, { token: A.token })).status).toBe(200);
    expect((await api.call("GET", `/catalog/items/${A.itemId}`, { token: A.token })).status).toBe(200);
    for (const [p, m] of [[`/prospects/${A.prospectId}`, "GET"], [`/catalog/items/${A.itemId}`, "GET"], [`/prospects/${A.prospectId}`, "PATCH"], [`/catalog/items/${A.itemId}`, "PATCH"], [`/memberships/${A.membershipId}`, "DELETE"]] as const) {
      const res = await api.call(m, p, { token: B.token, ...(m === "PATCH" ? { body: { name: "hack" } } : {}) });
      expect([403, 404]).toContain(res.status);
    }
    expect((await owner.query("SELECT name FROM prospects WHERE id = $1", [A.prospectId])).rows[0].name).toContain("SECRETO-bypass-a");
  });
});

describe("(e) a token stops granting access when the membership changes", () => {
  it("removing the membership invalidates the token; demotion drops permissions immediately", async () => {
    const m = await seedMember(A.orgId, "org_admin", "bypass-removed");
    const login = await api.call("POST", "/auth/login", { body: { email: m.email, password: PASSWORD } });
    expect(login.status).toBe(200);
    const token = login.body.token as string;
    expect((await api.call("GET", "/prospects", { token })).status).toBe(200);

    const demote = await api.call("PATCH", `/memberships/${m.membershipId}`, { token: A.token, body: { role: "viewer" } });
    expect(demote.status).toBe(200);
    expect((await api.call("POST", "/prospects", { token, body: { name: "No debe", domain: `n-${randomUUID().slice(0, 8)}.example` } })).status).toBe(403);

    const removal = await api.call("DELETE", `/memberships/${m.membershipId}`, { token: A.token });
    expect(removal.status).toBe(204);
    for (const path of ["/prospects", "/me", "/organization", `/prospects/${A.prospectId}`]) expect([401, 403, 404]).toContain((await api.call("GET", path, { token })).status);
  });

  it("a user of A who is also a member of B cannot reach B with the token issued for A", async () => {
    const m = await seedMember(A.orgId, "org_admin", "bypass-dual");
    await owner.query("INSERT INTO memberships (id, organization_id, user_id, role, updated_at) VALUES ($1,$2,$3,'org_admin', now())", [randomUUID(), B.orgId, m.userId]);
    const tokenA = (await api.call("POST", "/auth/login", { body: { email: m.email, password: PASSWORD, organizationSlug: A.slug } })).body.token as string;
    const list = await api.call("GET", "/prospects", { token: tokenA, headers: { "x-organization-id": B.orgId } });
    expect(JSON.stringify(list.body)).not.toContain("SECRETO-bypass-b");
    expect((await api.call("GET", `/prospects/${B.prospectId}`, { token: tokenA })).status).toBe(404);
  });
});

describe("(f) database level: no context means no rows, and FORCE closes the owner path", () => {
  const TABLES_WITH_ORG = async () =>
    (await owner.query(`SELECT c.relname, c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`)).rows as { relname: string; forced: boolean }[];

  /** Tables left without FORCE on purpose: each is used by a SECURITY DEFINER function (see 20261104100000_rls_force and MULTI_TENANCY.md). */
  const DOCUMENTED_EXCEPTIONS = [
    "audit_events", "campaigns", "consent_events", "contacts", "erased_addresses", "import_jobs", "invitations", "memberships",
    "message_drafts", "opportunity_stage_history", "privacy_requests", "retention_policies", "send_attempts", "sessions", "suppressions",
  ];

  it("app_runtime with an empty context reads zero rows from every tenant table", async () => {
    const tables = await TABLES_WITH_ORG();
    expect(tables.length).toBeGreaterThan(40);
    for (const ctx of [{}, { organizationId: randomUUID(), userId: randomUUID(), role: "org_admin" }]) {
      const leaks: string[] = [];
      await asRuntime(ctx, async (c) => {
        for (const t of tables) {
          // No SELECT privilege at all (e.g. erased_addresses) is an even stronger denial than RLS.
          if (!(await c.query("SELECT has_table_privilege('app_runtime', $1, 'SELECT') AS ok", [`public."${t.relname}"`])).rows[0].ok) continue;
          const n = Number((await c.query(`SELECT count(*) AS n FROM "${t.relname}"`)).rows[0].n);
          if (n !== 0) leaks.push(`${t.relname}:${n}`);
        }
      });
      expect(leaks).toEqual([]);
    }
  });

  it("every tenant table has FORCE except the documented definer-function exceptions", async () => {
    const unforced = (await TABLES_WITH_ORG()).filter((t) => !t.forced).map((t) => t.relname).sort();
    expect(unforced).toEqual([...DOCUMENTED_EXCEPTIONS].sort());
  });

  it("the application login role is neither superuser nor BYPASSRLS and owns nothing", async () => {
    const { rows } = await owner.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_runtime'");
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const login = await owner.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_login'");
    if (login.rowCount) {
      expect(login.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      expect((await owner.query("SELECT count(*)::int AS n FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname='app_login')")).rows[0].n).toBe(0);
    }
  });

  it("a NON-superuser owner of a forced table sees zero rows without context (and all rows on an exception table)", async () => {
    const su = (await owner.query("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")).rows[0].rolsuper as boolean;
    if (!su) return; // needs CREATE ROLE; the dev/test database user is a superuser
    const forcedWithRows: string[] = [];
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("CREATE ROLE rls_owner_probe NOSUPERUSER NOBYPASSRLS NOLOGIN");
      const tables = (await TABLES_WITH_ORG()).filter((t) => t.forced);
      expect(tables.length).toBeGreaterThanOrEqual(30);
      for (const t of tables) await c.query(`ALTER TABLE "${t.relname}" OWNER TO rls_owner_probe`);
      await c.query("ALTER TABLE memberships OWNER TO rls_owner_probe"); // exception table (prospects and leads are FORCE since owner visibility): owner still bypasses (documented)
      await c.query("SET LOCAL ROLE rls_owner_probe");
      await c.query("SELECT set_config('app.organization_id', '', true)");
      for (const t of tables) {
        const n = Number((await c.query(`SELECT count(*) AS n FROM "${t.relname}"`)).rows[0].n);
        if (n !== 0) forcedWithRows.push(`${t.relname}:${n}`);
      }
      expect(Number((await c.query("SELECT count(*) AS n FROM memberships")).rows[0].n)).toBeGreaterThan(0);
      // Writes by the owner are refused as well.
      await c.query("SAVEPOINT w");
      await expect(c.query("INSERT INTO branches (id, organization_id, name, updated_at) VALUES (gen_random_uuid(), $1, 'x', now())", [A.orgId])).rejects.toThrow(/row-level security|permission denied/i);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
    expect(forcedWithRows).toEqual([]);
  });
});

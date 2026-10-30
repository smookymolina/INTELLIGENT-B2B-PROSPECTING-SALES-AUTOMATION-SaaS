import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asRuntime, owner, seedMember, seedOrganization } from "./harness.js";

/**
 * Database-level isolation proofs. Everything runs as `app_runtime` (the role the API drops to), so these tests
 * fail if an RLS policy, privilege or trigger is removed, independent of any application code.
 */
type Tenant = { orgId: string; adminUser: string; adminMembership: string; viewerUser: string; sessionHash: string; auditId: string };

async function seedTenant(label: string): Promise<Tenant> {
  const org = await seedOrganization(label);
  const admin = await seedMember(org.id, "org_admin", `${label}-admin`);
  const viewer = await seedMember(org.id, "viewer", `${label}-viewer`);
  const sessionHash = randomUUID().replaceAll("-", "");
  await owner.query("INSERT INTO sessions (id, organization_id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4, now() + interval '1 hour')", [
    randomUUID(),
    org.id,
    admin.userId,
    sessionHash,
  ]);
  const auditId = randomUUID();
  await owner.query("INSERT INTO audit_events (id, organization_id, actor_user_id, action, resource_type) VALUES ($1,$2,$3,'seed','organization')", [
    auditId,
    org.id,
    admin.userId,
  ]);
  return { orgId: org.id, adminUser: admin.userId, adminMembership: admin.membershipId, viewerUser: viewer.userId, sessionHash, auditId };
}

/** Runs one statement in its own transaction (a failed statement aborts the whole transaction) and returns the error message. */
const denied = (ctx: Parameters<typeof asRuntime>[0], sql: string, params: unknown[] = []) =>
  asRuntime(ctx, async (c) => {
    try {
      await c.query(sql, params);
      return "NO ERROR";
    } catch (e) {
      return (e as Error).message;
    }
  });

let A: Tenant;
let B: Tenant;
const ctxOf = (t: Tenant, role = "org_admin") => ({ organizationId: t.orgId, userId: t.adminUser, role });
const count = async (c: { query: (q: string) => Promise<{ rows: { n: string }[] }> }, table: string) =>
  Number((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);

beforeAll(async () => {
  A = await seedTenant("tenant-a");
  B = await seedTenant("tenant-b");
});
afterAll(async () => {
  await owner.end();
});

describe("runtime role", () => {
  it("is unprivileged: not superuser, no BYPASSRLS, owns no tables", async () => {
    const { rows } = await owner.query("SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'app_runtime'");
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: false });
    const owned = await owner.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tableowner='app_runtime'");
    expect(owned.rows[0].n).toBe(0);
  });

  it("has RLS enabled on every tenant table", async () => {
    const { rows } = await owner.query(
      "SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND NOT relrowsecurity AND relname <> '_prisma_migrations'",
    );
    expect(rows).toEqual([]);
  });
});

describe("fail closed without verified context", () => {
  it.each(["organizations", "users", "memberships", "sessions", "audit_events"])("%s returns no rows with no context", async (table) => {
    await asRuntime({}, async (c) => expect(await count(c, table)).toBe(0));
  });

  it("cannot insert anything without context", async () => {
    await asRuntime({}, async (c) => {
      await expect(c.query("INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1,'x','x-no-ctx', now())", [randomUUID()])).rejects.toThrow(/row-level security/);
    });
  });
});

describe("cross-tenant reads", () => {
  it("tenant A sees only its own organization, memberships, sessions and audit events", async () => {
    await asRuntime(ctxOf(A), async (c) => {
      expect((await c.query("SELECT id FROM organizations")).rows.map((r) => r.id)).toEqual([A.orgId]);
      const m = await c.query("SELECT DISTINCT organization_id FROM memberships");
      expect(m.rows.map((r) => r.organization_id)).toEqual([A.orgId]);
      expect((await c.query("SELECT 1 FROM sessions WHERE organization_id = $1", [B.orgId])).rowCount).toBe(0);
      expect((await c.query("SELECT 1 FROM audit_events WHERE organization_id = $1", [B.orgId])).rowCount).toBe(0);
      expect((await c.query("SELECT 1 FROM audit_events WHERE id = $1", [B.auditId])).rowCount).toBe(0);
    });
  });

  it("targeting another tenant's ids directly returns nothing", async () => {
    await asRuntime(ctxOf(A), async (c) => {
      expect((await c.query("SELECT 1 FROM organizations WHERE id = $1", [B.orgId])).rowCount).toBe(0);
      expect((await c.query("SELECT 1 FROM memberships WHERE id = $1", [B.adminMembership])).rowCount).toBe(0);
      expect((await c.query("SELECT 1 FROM users WHERE id = $1", [B.adminUser])).rowCount).toBe(0);
    });
  });

  it("users are visible only for the caller and members of the current tenant", async () => {
    await asRuntime(ctxOf(A), async (c) => {
      const ids = (await c.query("SELECT id FROM users")).rows.map((r) => r.id).sort();
      expect(ids).toEqual([A.adminUser, A.viewerUser].sort());
    });
  });

  it("password hashes are unreadable even inside the own tenant", async () => {
    expect(await denied(ctxOf(A), "SELECT password_hash FROM users")).toMatch(/permission denied/);
    expect(await denied(ctxOf(A), "SELECT * FROM users")).toMatch(/permission denied/);
  });

  it("an empty-string context also fails closed", async () => {
    await asRuntime({ organizationId: "", userId: A.adminUser, role: "org_admin" }, async (c) => {
      expect(await count(c, "memberships")).toBe(0);
    });
  });
});

describe("cross-tenant writes", () => {
  it("cannot insert rows that belong to another tenant", async () => {
    await asRuntime(ctxOf(A), async (c) => {
      await expect(
        c.query("INSERT INTO memberships (id, organization_id, user_id, role, updated_at) VALUES ($1,$2,$3,'viewer', now())", [randomUUID(), B.orgId, A.viewerUser]),
      ).rejects.toThrow(/row-level security/);
    });
    await asRuntime(ctxOf(A), async (c) => {
      await expect(
        c.query("INSERT INTO audit_events (id, organization_id, action, resource_type) VALUES ($1,$2,'forged','x')", [randomUUID(), B.orgId]),
      ).rejects.toThrow(/row-level security/);
    });
    await asRuntime(ctxOf(A), async (c) => {
      await expect(
        c.query("INSERT INTO sessions (id, organization_id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4, now() + interval '1 hour')", [
          randomUUID(),
          B.orgId,
          A.adminUser,
          randomUUID(),
        ]),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it("updates and deletes against another tenant affect zero rows", async () => {
    await asRuntime(ctxOf(A), async (c) => {
      expect((await c.query("UPDATE memberships SET role = 'viewer' WHERE id = $1", [B.adminMembership])).rowCount).toBe(0);
      expect((await c.query("DELETE FROM memberships WHERE id = $1", [B.adminMembership])).rowCount).toBe(0);
      expect((await c.query("UPDATE organizations SET name = 'pwned' WHERE id = $1", [B.orgId])).rowCount).toBe(0);
    });
    const { rows } = await owner.query("SELECT role FROM memberships WHERE id = $1", [B.adminMembership]);
    expect(rows[0].role).toBe("org_admin");
  });

  it("cannot move a row to another tenant (organization_id is immutable)", async () => {
    await asRuntime(ctxOf(A), async (c) => {
      await expect(c.query("UPDATE memberships SET organization_id = $1 WHERE id = $2", [B.orgId, A.adminMembership])).rejects.toThrow(/permission denied/);
    });
  });

  it("cannot take over another identity", async () => {
    await asRuntime(ctxOf(A), async (c) => {
      expect((await c.query("UPDATE users SET display_name = 'x' WHERE id = $1", [B.adminUser])).rowCount).toBe(0);
    });
    expect(await denied(ctxOf(A), "UPDATE users SET email = 'x@example.test' WHERE id = $1", [A.adminUser])).toMatch(/permission denied/);
    expect(
      await denied(ctxOf(A), "INSERT INTO users (id, email, password_hash, display_name, updated_at) VALUES ($1,'evil@example.test','h','evil', now())", [randomUUID()]),
    ).toMatch(/row-level security/);
  });
});

describe("role enforcement inside RLS", () => {
  it("non-admin roles cannot write memberships or rename the organization even in their own tenant", async () => {
    await asRuntime(ctxOf(A, "viewer"), async (c) => {
      expect((await c.query("UPDATE memberships SET role = 'org_admin' WHERE id = $1", [A.adminMembership])).rowCount).toBe(0);
      expect((await c.query("DELETE FROM memberships WHERE id = $1", [A.adminMembership])).rowCount).toBe(0);
      expect((await c.query("UPDATE organizations SET name = 'x' WHERE id = $1", [A.orgId])).rowCount).toBe(0);
      await expect(
        c.query("INSERT INTO memberships (id, organization_id, user_id, role, updated_at) VALUES ($1,$2,$3,'org_admin', now())", [randomUUID(), A.orgId, A.viewerUser]),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it("a missing role claim is treated as no role", async () => {
    await asRuntime({ organizationId: A.orgId, userId: A.adminUser }, async (c) => {
      expect((await c.query("DELETE FROM memberships WHERE id = $1", [A.adminMembership])).rowCount).toBe(0);
    });
  });
});

describe("audit_events is append-only", () => {
  it("runtime can append in its tenant but never update, delete or truncate", async () => {
    await asRuntime(ctxOf(A), async (c) => {
      const r = await c.query("INSERT INTO audit_events (id, organization_id, action, resource_type) VALUES ($1,$2,'test.append','x')", [randomUUID(), A.orgId]);
      expect(r.rowCount).toBe(1);
    });
    expect(await denied(ctxOf(A), "UPDATE audit_events SET action = 'tampered'")).toMatch(/permission denied/);
    expect(await denied(ctxOf(A), "DELETE FROM audit_events")).toMatch(/permission denied/);
    expect(await denied(ctxOf(A), "TRUNCATE audit_events")).toMatch(/permission denied/);
  });

  it("even the table owner is blocked by the trigger", async () => {
    await expect(owner.query("UPDATE audit_events SET action = 'tampered' WHERE id = $1", [A.auditId])).rejects.toThrow(/append-only/);
    await expect(owner.query("DELETE FROM audit_events WHERE id = $1", [A.auditId])).rejects.toThrow(/append-only/);
    await expect(owner.query("TRUNCATE audit_events")).rejects.toThrow(/append-only/);
  });
});

describe("auth functions (pre-tenant)", () => {
  const resolve = (hash: string) => asRuntime({}, (c) => c.query("SELECT * FROM auth_resolve_session($1)", [hash]));

  it("resolve a valid session to its own tenant and role only", async () => {
    const { rows } = await resolve(A.sessionHash);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organization_id: A.orgId, user_id: A.adminUser, role: "org_admin" });
  });

  it("reject unknown, revoked, expired, and membership-removed sessions", async () => {
    expect((await resolve("does-not-exist")).rowCount).toBe(0);

    const t = await seedTenant("tenant-x");
    await owner.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1", [t.sessionHash]);
    expect((await resolve(t.sessionHash)).rowCount).toBe(0);

    const e = await seedTenant("tenant-e");
    await owner.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [e.sessionHash]);
    expect((await resolve(e.sessionHash)).rowCount).toBe(0);

    const r = await seedTenant("tenant-r");
    await owner.query("DELETE FROM memberships WHERE id = $1", [r.adminMembership]);
    expect((await resolve(r.sessionHash)).rowCount).toBe(0);
  });

  it("only expose the auth functions, not the underlying tables, without context", async () => {
    await asRuntime({}, async (c) => {
      expect(await count(c, "sessions")).toBe(0);
      await expect(c.query("SELECT password_hash FROM auth_lookup_user('nobody@example.test')")).resolves.toBeDefined();
    });
  });
});

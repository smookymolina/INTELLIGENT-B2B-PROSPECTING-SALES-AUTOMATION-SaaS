import { afterAll, describe, expect, it } from "vitest";
import { assertDbRoles, type RoleRow } from "../db/role-guard.js";
import { owner, startApi } from "./harness.js";

/** The real database satisfies the role invariants, and production mode refuses a privileged connection. */
const ROLES = `SELECT 'session' AS who, r.rolsuper, r.rolbypassrls, r.rolcanlogin FROM pg_roles r WHERE r.rolname = session_user
  UNION ALL SELECT 'runtime' AS who, r.rolsuper, r.rolbypassrls, r.rolcanlogin FROM pg_roles r WHERE r.rolname = 'app_runtime'`;

afterAll(() => {
  delete process.env.REQUIRE_UNPRIVILEGED_DB_ROLE;
});

describe("database roles", () => {
  it("app_runtime exists and is NOLOGIN, not superuser and not BYPASSRLS (migrations guarantee it)", async () => {
    const rows = (await owner.query(ROLES)).rows as RoleRow[];
    const runtime = rows.find((r) => r.who === "runtime");
    expect(runtime).toEqual({ who: "runtime", rolsuper: false, rolbypassrls: false, rolcanlogin: false });
    expect(() => assertDbRoles(rows, {})).not.toThrow();
  });

  it("REQUIRE_UNPRIVILEGED_DB_ROLE=1 makes the API refuse to start on a privileged connection (and start on a least-privilege one)", async () => {
    const session = ((await owner.query(ROLES)).rows as RoleRow[]).find((r) => r.who === "session")!;
    const privileged = session.rolsuper || session.rolbypassrls;
    process.env.REQUIRE_UNPRIVILEGED_DB_ROLE = "1";
    if (privileged) {
      await expect(startApi()).rejects.toThrow(/least-privilege/);
    } else {
      const api = await startApi();
      expect((await api.call("GET", "/health/ready")).status).toBe(200);
      await api.close();
    }
  });
});

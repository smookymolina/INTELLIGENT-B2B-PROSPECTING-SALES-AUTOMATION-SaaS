import { describe, expect, it } from "vitest";
import { assertDbRoles, type RoleRow } from "./role-guard.js";

const runtime = (over: Partial<RoleRow> = {}): RoleRow => ({ who: "runtime", rolsuper: false, rolbypassrls: false, rolcanlogin: false, ...over });
const session = (over: Partial<RoleRow> = {}): RoleRow => ({ who: "session", rolsuper: false, rolbypassrls: false, rolcanlogin: true, ...over });

describe("assertDbRoles", () => {
  it("accepts a least-privilege login role and an unprivileged app_runtime without warnings", () => {
    expect(assertDbRoles([session(), runtime()], {})).toEqual([]);
  });
  it("fails when app_runtime is missing, privileged or able to log in", () => {
    expect(() => assertDbRoles([session()], {})).toThrow(/does not exist/);
    expect(() => assertDbRoles([session(), runtime({ rolsuper: true })], {})).toThrow(/SUPERUSER or BYPASSRLS/);
    expect(() => assertDbRoles([session(), runtime({ rolbypassrls: true })], {})).toThrow(/SUPERUSER or BYPASSRLS/);
    expect(() => assertDbRoles([session(), runtime({ rolcanlogin: true })], {})).toThrow(/NOLOGIN/);
  });
  it("warns about a privileged connection in development and refuses it when REQUIRE_UNPRIVILEGED_DB_ROLE=1", () => {
    expect(assertDbRoles([session({ rolsuper: true }), runtime()], {})[0]).toMatch(/development/);
    expect(assertDbRoles([session({ rolbypassrls: true }), runtime()], {})).toHaveLength(1);
    expect(() => assertDbRoles([session({ rolsuper: true }), runtime()], { REQUIRE_UNPRIVILEGED_DB_ROLE: "1" })).toThrow(/least-privilege/);
    expect(assertDbRoles([session(), runtime()], { REQUIRE_UNPRIVILEGED_DB_ROLE: "1" })).toEqual([]);
  });
});

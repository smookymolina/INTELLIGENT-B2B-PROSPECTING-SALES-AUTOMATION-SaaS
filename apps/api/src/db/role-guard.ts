export type RoleRow = Readonly<{ who: "session" | "runtime"; rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>;

/**
 * Startup invariants for the database roles (ADR on RLS without FORCE):
 * - `app_runtime` must exist and must NOT be superuser, BYPASSRLS or able to log in (every request runs as that role).
 * - The connecting role may be privileged in development (the compose database user is a superuser), but production must set
 *   REQUIRE_UNPRIVILEGED_DB_ROLE=1 so the process refuses to start with a role that could bypass row-level security if any code
 *   path ever skipped `SET LOCAL ROLE`. Returns warnings; throws on violations.
 */
export function assertDbRoles(rows: readonly RoleRow[], env: NodeJS.ProcessEnv = process.env): string[] {
  const runtime = rows.find((r) => r.who === "runtime");
  if (!runtime) throw new Error("Database role app_runtime does not exist: run the migrations before starting the API");
  if (runtime.rolsuper || runtime.rolbypassrls) throw new Error("Database role app_runtime must not be SUPERUSER or BYPASSRLS");
  if (runtime.rolcanlogin) throw new Error("Database role app_runtime must be NOLOGIN (it is only reachable through SET ROLE)");
  const session = rows.find((r) => r.who === "session");
  const privileged = !!session && (session.rolsuper || session.rolbypassrls);
  if (!privileged) return [];
  if (env.REQUIRE_UNPRIVILEGED_DB_ROLE === "1") throw new Error("DATABASE_URL connects with a SUPERUSER/BYPASSRLS role and REQUIRE_UNPRIVILEGED_DB_ROLE=1: use a least-privilege login role that can SET ROLE app_runtime");
  return ["DATABASE_URL connects with a privileged role (acceptable only in development). Set REQUIRE_UNPRIVILEGED_DB_ROLE=1 in production."];
}

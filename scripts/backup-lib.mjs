// Shared helpers for backup.mjs / restore-verify.mjs. Talks to the `postgres` service of docker-compose.yml via `docker compose exec`.
// No passwords are used or logged: the commands run as the container's `app` user over the local socket.
import { spawn } from "node:child_process";

export const PG_USER = process.env.BACKUP_PG_USER ?? "app";

export function assertIdent(name, label) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`${label} must be a plain lowercase identifier`);
  return name;
}

// Runs `docker compose exec -T postgres <args>`; resolves with { code, stdout, stderr }. `stdin` (Buffer/stream) optional.
export function pgExec(args, { stdin, stdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "exec", "-T", "postgres", ...args], { stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    if (stdout) child.stdout.pipe(stdout, { end: true });
    else child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    if (stdin) stdin.pipe(child.stdin);
  });
}

export async function psql(db, sql) {
  const r = await pgExec(["psql", "-U", PG_USER, "-d", db, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql]);
  if (r.code !== 0) throw new Error(`psql failed on ${db}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

// Exact row count per table of schema public (query_to_xml avoids per-table statements).
export async function tableCounts(db) {
  const out = await psql(
    db,
    `SELECT table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
     FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
  );
  const counts = {};
  for (const line of out.split("\n").filter(Boolean)) {
    const [t, c] = line.split("|");
    counts[t] = Number(c);
  }
  return counts;
}

export async function lastMigration(db) {
  return (await psql(db, "SELECT coalesce(max(migration_name), '') FROM _prisma_migrations WHERE finished_at IS NOT NULL")) || null;
}

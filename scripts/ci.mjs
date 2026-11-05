// Reproducible CI: isolated DB -> migrations -> check -> test:int -> build -> test:e2e -> backup + verify -> results table.
// Usage: npm run ci   (exit code != 0 if any stage fails; the table is always printed)
// Env: CI_DB (default prospecting_ci_test, must end in _test), CI_DB_ADMIN_URL (default postgresql://app:app@localhost:5432/postgres),
//      CI_SKIP_BACKUP=1 (no `docker compose` postgres available, e.g. GitHub Actions service container), CI_KEEP_DB=1 (do not drop the DB).
// Full output of each stage goes to ci-logs/<stage>.log; the console shows progress + a heartbeat every 30 s (no short timeout is imposed).
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const logDir = join(root, "ci-logs");
mkdirSync(logDir, { recursive: true });

const dbName = process.env.CI_DB ?? "prospecting_ci_test";
if (!/^[a-z_][a-z0-9_]*_test$/.test(dbName)) throw new Error(`CI_DB must be a lowercase identifier ending in _test (got "${dbName}")`);
const adminUrl = process.env.CI_DB_ADMIN_URL ?? "postgresql://app:app@localhost:5432/postgres";
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${dbName}`;
const skipBackup = process.env.CI_SKIP_BACKUP === "1";
const keepDb = process.env.CI_KEEP_DB === "1";

const env = { ...process.env, TEST_DATABASE_URL: testUrl.toString(), DATABASE_URL: testUrl.toString(), BACKUP_DB: dbName };
// ANSI-stripped vitest summary: "Tests  453 passed (453)" / "Tests  2 failed | 451 passed (453)" / "Test Files ..."
const ANSI = /\u001b\[[0-9;]*m/g;
function parseTests(text) {
  const clean = text.replace(ANSI, "");
  let total = null;
  const found = [];
  for (const m of clean.matchAll(/^\s*Tests\s+(.+)$/gm)) found.push(m[1]);
  if (!found.length) return null;
  const line = found.reduce((a, b) => a + " + " + b); // several workspaces may each print a summary
  let passed = 0, failed = 0, skipped = 0;
  for (const m of line.matchAll(/(\d+) passed/g)) passed += +m[1];
  for (const m of line.matchAll(/(\d+) failed/g)) failed += +m[1];
  for (const m of line.matchAll(/(\d+) skipped/g)) skipped += +m[1];
  total = passed + failed + skipped;
  return { passed, failed, skipped, total };
}

const results = [];
let failed = false;
const t0 = Date.now();
const fmt = (ms) => `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s`;
const log = (m) => console.log(`[ci ${fmt(Date.now() - t0)}] ${m}`);

function run(name, command, { countTests = false } = {}) {
  return new Promise((resolve) => {
    if (failed) { results.push({ name, command, status: "SKIPPED", tests: "-", ms: 0 }); return resolve(); }
    log(`>>> ${name}: ${command}`);
    const start = Date.now();
    const file = join(logDir, `${name}.log`);
    const out = createWriteStream(file);
    let buf = "";
    const child = spawn(command, { cwd: root, env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const onData = (d) => { out.write(d); buf += d; if (buf.length > 4e6) buf = buf.slice(-2e6); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const beat = setInterval(() => log(`    ... ${name} still running (${fmt(Date.now() - start)})`), 30000);
    child.on("close", (code) => {
      clearInterval(beat);
      out.end();
      const ms = Date.now() - start;
      const t = countTests ? parseTests(buf) : null;
      let tests = "-";
      if (countTests) tests = t ? `${t.passed}/${t.total}${t.failed ? ` (${t.failed} failed)` : ""}${t.skipped ? ` (${t.skipped} skipped)` : ""}` : "n/a";
      const ok = code === 0;
      if (!ok) { failed = true; console.log(buf.split("\n").slice(-40).join("\n")); }
      results.push({ name, command, status: ok ? "OK" : `FAIL(${code})`, tests, ms });
      log(`<<< ${name}: ${ok ? "OK" : "FAIL"} in ${fmt(ms)}  tests=${tests}  (log: ci-logs/${name}.log)`);
      resolve();
    });
  });
}

async function step(name, command, fn) {
  if (failed) { results.push({ name, command, status: "SKIPPED", tests: "-", ms: 0 }); return; }
  log(`>>> ${name}: ${command}`);
  const start = Date.now();
  try {
    await fn();
    results.push({ name, command, status: "OK", tests: "-", ms: Date.now() - start });
  } catch (e) {
    failed = true;
    console.error(`[ci] ${name} failed: ${e.message}`);
    results.push({ name, command, status: "FAIL", tests: "-", ms: Date.now() - start });
  }
  log(`<<< ${name}: ${results.at(-1).status} in ${fmt(results.at(-1).ms)}`);
}

const portBusy = (port) => new Promise((res) => {
  const s = createConnection({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); res(true); });
  s.once("error", () => res(false));
});

let dbCreated = false;
async function withAdmin(fn) {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

try {
  await step("preflight", "ports 3991/3992 free + postgres reachable", async () => {
    for (const p of [3991, 3992]) if (await portBusy(p)) throw new Error(`port ${p} is in use; stop the process using it (e2e needs 3991/3992)`);
    await withAdmin((c) => c.query("SELECT 1"));
    if (!skipBackup) {
      await new Promise((res, rej) => spawn("docker info", { shell: true, stdio: "ignore" }).on("close", (c) => (c === 0 ? res() : rej(new Error("docker is not running (needed for backup); set CI_SKIP_BACKUP=1 to skip")))));
    }
  });
  await step("db-create", `DROP/CREATE DATABASE ${dbName}`, async () => {
    await withAdmin(async (c) => {
      await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await c.query(`CREATE DATABASE "${dbName}"`);
      dbCreated = true;
    });
  });
  await run("migrate", "node scripts/db-test-setup.mjs");
  await run("check", "npm run check", { countTests: true });
  await run("test-int", "npm run test:int", { countTests: true });
  await run("build", "npm run build");
  await step("e2e-ports", "ports 3991/3992 free after build", async () => {
    for (const p of [3991, 3992]) if (await portBusy(p)) throw new Error(`port ${p} is in use before e2e`);
  });
  await run("test-e2e", "npm run test:e2e");
  if (skipBackup) results.push({ name: "backup", command: "npm run backup", status: "SKIPPED (CI_SKIP_BACKUP)", tests: "-", ms: 0 }, { name: "backup-verify", command: "npm run backup:verify", status: "SKIPPED (CI_SKIP_BACKUP)", tests: "-", ms: 0 });
  else {
    await run("backup", "npm run backup");
    await run("backup-verify", "npm run backup:verify");
  }
} finally {
  if (dbCreated && !keepDb) {
    try {
      await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`));
      log(`database ${dbName} dropped`);
    } catch (e) { console.error(`[ci] could not drop ${dbName}: ${e.message}`); }
    try { // remove the dumps this run created for the isolated DB only
      for (const f of readdirSync(join(root, "backups"))) if (f.startsWith(`${dbName}-`)) unlinkSync(join(root, "backups", f));
    } catch { /* no backups dir */ }
  }
}

const total = Date.now() - t0;
const rows = results.map((r) => [r.name, r.command, r.status, r.tests, r.ms ? fmt(r.ms) : "-"]);
const head = ["stage", "command", "result", "tests (passed/total)", "duration"];
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
const line = (r) => "| " + r.map((c, i) => String(c).padEnd(w[i])).join(" | ") + " |";
console.log("\n" + [line(head), "|" + w.map((x) => "-".repeat(x + 2)).join("|") + "|", ...rows.map(line)].join("\n"));
console.log(`\nTotal: ${fmt(total)}  =>  ${failed ? "CI FAILED" : "CI PASSED"}`);
process.exit(failed ? 1 : 0);

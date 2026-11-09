// Restores a dump into a throwaway DB (default prospecting_restore_check), compares table counts + last migration with the manifest,
// and ALWAYS drops the throwaway DB. Exit code != 0 on any difference.
// Usage: node scripts/restore-verify.mjs [--file backups/x.dump] [--manifest backups/x.json] [--target <db> --yes [--force]]
// Env: BACKUP_DB (default prospecting) selects which DB's latest dump to use when --file is absent.
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { assertIdent, backupKey, decryptToTemp, lastMigration, pgExec, psql, PG_USER, tableCounts } from "./backup-lib.mjs";

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(n);
const TEMP = "prospecting_restore_check";

const srcDb = assertIdent(process.env.BACKUP_DB ?? "prospecting", "BACKUP_DB");
let file = opt("--file");
if (!file) {
  const own = new RegExp(`^${srcDb}-\\d{8}T\\d{6}Z\\.dump(\\.enc)?$`);
  const latest = readdirSync("backups").filter((f) => own.test(f)).sort().pop();
  if (!latest) throw new Error(`no dump found in backups/ for ${srcDb}`);
  file = join("backups", latest);
}
const manifestPath = opt("--manifest") ?? file.replace(/\.dump(\.enc)?$/, ".json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const target = assertIdent(opt("--target") ?? TEMP, "--target");
const isTemp = target === TEMP;
if (!isTemp && !has("--yes")) throw new Error("restoring into a non-temporary DB needs --target <db> --yes");
if (target === "template0" || target === "template1" || target === "postgres") throw new Error("refusing to restore into a system DB");

const t0 = Date.now();
const problems = [];
let created = false;
try {
  // 1) integrity of the file itself
  const hash = createHash("sha256");
  for await (const c of createReadStream(file)) hash.update(c);
  if (hash.digest("hex") !== manifest.sha256) problems.push(`sha256 mismatch for ${basename(file)}`);

  // 2) prepare target
  const exists = (await psql("postgres", `SELECT 1 FROM pg_database WHERE datname = '${target}'`)) === "1";
  if (exists) {
    if (isTemp) await psql("postgres", `DROP DATABASE "${target}" WITH (FORCE)`); // our own leftover
    else {
      const n = Number(await psql(target, "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"));
      if (n > 0 && !has("--force")) throw new Error(`${target} is not empty (${n} tables); pass --force to restore over it`);
    }
  }
  if (!exists || isTemp) { await psql("postgres", `CREATE DATABASE "${target}"`); created = true; }

  // 2b) encrypted backups are decrypted to a temp file (wrong key / tampering throws here)
  let restoreFile = file;
  if (manifest.encrypted) {
    const key = backupKey();
    if (!key) throw new Error("backup is encrypted: set BACKUP_ENCRYPTION_KEY");
    restoreFile = await decryptToTemp(file, key);
  }

  // 3) restore (dump is streamed through stdin; --clean only for an explicit --force into an existing DB)
  const flags = ["--no-owner", "--exit-on-error", ...(has("--force") && !isTemp ? ["--clean", "--if-exists"] : [])];
  const r = await pgExec(["pg_restore", "-U", PG_USER, "-d", target, ...flags], { stdin: createReadStream(restoreFile) });
  if (restoreFile !== file) try { unlinkSync(restoreFile); } catch {}
  if (r.code !== 0) problems.push(`pg_restore failed: ${r.stderr.trim().split("\n").slice(0, 3).join(" | ")}`);

  // 4) compare
  if (r.code === 0) {
    const got = await tableCounts(target);
    const want = manifest.tableCounts;
    for (const t of new Set([...Object.keys(want), ...Object.keys(got)])) {
      if (want[t] !== got[t]) problems.push(`table ${t}: manifest=${want[t] ?? "absent"} restored=${got[t] ?? "absent"}`);
    }
    const mig = await lastMigration(target);
    if (mig !== manifest.lastMigration) problems.push(`last migration: manifest=${manifest.lastMigration} restored=${mig}`);
    const total = Object.values(got).reduce((a, b) => a + b, 0);
    console.log(`restored ${basename(file)} into ${target}: ${Object.keys(got).length} tables, ${total} rows, last migration ${mig}`);
  }
} catch (e) {
  problems.push(String(e.message ?? e));
} finally {
  if (isTemp) {
    try { await psql("postgres", `DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`); console.log(`temporary DB ${target} dropped`); }
    catch (e) { problems.push(`could not drop ${target}: ${e.message}`); }
  }
}
console.log(`elapsed ${Date.now() - t0} ms`);
if (problems.length) {
  console.error("RESTORE VERIFY FAILED:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.log("RESTORE VERIFY OK: counts and last migration match the manifest");

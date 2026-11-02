// Logical backup of the dev database: pg_dump -Fc (inside the postgres container) -> backups/<db>-<UTC>.dump + .json manifest.
// Env: BACKUP_DB (default prospecting), BACKUP_KEEP (default 7; rotation only touches this DB's own dumps).
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertIdent, lastMigration, pgExec, PG_USER, tableCounts } from "./backup-lib.mjs";

const db = assertIdent(process.env.BACKUP_DB ?? "prospecting", "BACKUP_DB");
const keep = Number(process.env.BACKUP_KEEP ?? 7);
if (!Number.isInteger(keep) || keep < 1) throw new Error("BACKUP_KEEP must be an integer >= 1");

const dir = "backups";
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); // 20261102T120000Z
const file = join(dir, `${db}-${stamp}.dump`);
const t0 = Date.now();

// Counts are taken just before the dump; restore-verify compares against them (quiet dev DB assumed).
const counts = await tableCounts(db);
const migration = await lastMigration(db);

const dump = await pgExec(["pg_dump", "-Fc", "-U", PG_USER, "-d", db], { stdout: createWriteStream(file) });
if (dump.code !== 0) throw new Error(`pg_dump failed: ${dump.stderr.trim()}`);

const hash = createHash("sha256");
for await (const chunk of createReadStream(file)) hash.update(chunk);
const version = (await pgExec(["pg_dump", "--version"])).stdout.trim();

const manifest = {
  database: db,
  file: `${db}-${stamp}.dump`,
  createdAtUtc: new Date().toISOString(),
  sha256: hash.digest("hex"),
  sizeBytes: statSync(file).size,
  pgDumpVersion: version,
  lastMigration: migration,
  tableCounts: counts,
  durationMs: Date.now() - t0,
};
writeFileSync(file.replace(/\.dump$/, ".json"), JSON.stringify(manifest, null, 2) + "\n");

// Rotation: only `<db>-<timestamp>.dump` files of this exact DB (prefix match is anchored on the timestamp shape).
const own = new RegExp(`^${db}-\\d{8}T\\d{6}Z\\.dump$`);
const dumps = readdirSync(dir).filter((f) => own.test(f)).sort().reverse();
for (const old of dumps.slice(keep)) {
  unlinkSync(join(dir, old));
  try { unlinkSync(join(dir, old.replace(/\.dump$/, ".json"))); } catch {}
  console.log(`rotated out ${old}`);
}

console.log(`backup ok: ${file} (${manifest.sizeBytes} bytes, ${Object.keys(counts).length} tables, last migration ${migration}, ${manifest.durationMs} ms)`);

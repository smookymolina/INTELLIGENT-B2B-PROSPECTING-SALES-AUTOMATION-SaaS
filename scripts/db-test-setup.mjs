// Creates the disposable integration-test database (if missing) and applies all migrations.
// Usage: npm run db:test:setup   (use `-- --reset` to drop and recreate the test database)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testUrl = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://app:app@localhost:5432/prospecting_test");
const dbName = testUrl.pathname.slice(1);
if (!/_test$/.test(dbName)) throw new Error(`Refusing to touch database "${dbName}": test databases must end in _test`);

const admin = new URL(testUrl);
admin.pathname = "/postgres";
const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
try {
  if (process.argv.includes("--reset")) await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
  if (!rowCount) await client.query(`CREATE DATABASE "${dbName}"`);
} finally {
  await client.end();
}

const result = spawnSync(process.execPath, [join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy"], {
  cwd: join(root, "apps/api"),
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: testUrl.toString() },
});
process.exit(result.status ?? 1);

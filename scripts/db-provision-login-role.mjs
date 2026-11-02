// Creates (or rotates) the least-privilege login role the API connects with. It is NOT a superuser and cannot bypass RLS; every request
// still drops to `app_runtime` per transaction. Run after the migrations, as the owner role.
// Env: DATABASE_URL (owner), APP_DB_USER (default app_login), APP_DB_PASSWORD (required, >= 16 chars).
import pg from "pg";

const user = process.env.APP_DB_USER ?? "app_login";
const password = process.env.APP_DB_PASSWORD ?? "";
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(user)) throw new Error("APP_DB_USER must be a plain lowercase identifier");
if (password.length < 16) throw new Error("APP_DB_PASSWORD must be set to at least 16 characters");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const exists = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [user])).rowCount > 0;
  const verb = exists ? "ALTER" : "CREATE";
  const { rows } = await client.query(
    `SELECT format('${verb} ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION', $1::text, $2::text) AS sql`,
    [user, password],
  );
  await client.query(rows[0].sql);
  await client.query(`GRANT app_runtime TO "${user}"`);
  console.log(`login role ${user}: ${exists ? "rotated" : "created"}`);
} finally {
  await client.end();
}

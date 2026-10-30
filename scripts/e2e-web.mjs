// End-to-end smoke test of the real stack: compiled API + `next start` (production mode) against the *_test database.
// Prerequisites: `npm run build`, PostgreSQL up, `npm run db:test:setup`. Usage: npm run test:e2e
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = 3991;
const WEB_PORT = 3992;
const API = `http://127.0.0.1:${API_PORT}/v1`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const dbUrl = process.env.TEST_DATABASE_URL ?? "postgresql://app:app@localhost:5432/prospecting_test";
if (!/_test$/.test(new URL(dbUrl).pathname.slice(1))) throw new Error("e2e only runs against a *_test database");

const children = [];
const logs = [];
function start(name, args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => logs.push(`[${name}] ${d}`));
  child.stderr.on("data", (d) => logs.push(`[${name}] ${d}`));
  children.push(child);
  return child;
}
async function waitFor(url, label) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url, { redirect: "manual" })).status < 500) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not start`);
}

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n${e.stack ?? e}`);
    throw e;
  }
}

const form = (body) => ({ method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: WEB, host: `127.0.0.1:${WEB_PORT}` }, body: new URLSearchParams(body) });
const cookieOf = (res) => {
  const raw = res.headers.getSetCookie().find((c) => /^(__Host-)?session=/.test(c));
  return raw ? { raw, pair: raw.split(";")[0] } : null;
};
/** Page HTML without React text-node separators. */
const html = async (res) => (await res.text()).replace(/<!-- -->/g, "");
const get = (path, cookie) => fetch(`${WEB}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
const api = async (method, path, token, body) => {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : null });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

try {
  start("api", [join(root, "apps/api/dist/main.js")], join(root, "apps/api"), {
    DATABASE_URL: dbUrl, API_PORT: String(API_PORT), HMAC_SECRET: "e2e-only-hmac-secret-0123456789abcdef", ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"), TRUST_PROXY: "1", NODE_ENV: "production",
  });
  await waitFor(`${API}/health`, "API");
  start("web", [join(root, "node_modules/next/dist/bin/next"), "start", "-p", String(WEB_PORT), "-H", "127.0.0.1"], join(root, "apps/web"), { API_URL: `http://127.0.0.1:${API_PORT}`, NODE_ENV: "production" });
  await waitFor(`${WEB}/login`, "web");

  const email = `e2e-${randomUUID().slice(0, 8)}@example.test`;
  const password = "e2e correct horse battery";
  const orgName = `Org E2E ${randomUUID().slice(0, 6)}`;
  let session; // { pair, token }

  await step("login page renders with security headers and no server banner", async () => {
    const res = await get("/login");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Iniciar sesión/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-powered-by"), null);
  });

  await step("private pages redirect anonymous visitors to /login", async () => {
    for (const path of ["/", "/catalog", "/company"]) {
      const res = await get(path);
      assert.ok([307, 308].includes(res.status), `${path} -> ${res.status}`);
      assert.match(res.headers.get("location") ?? "", /\/login$/);
    }
    const tampered = await get("/", "__Host-session=not-a-real-token-but-long-enough-xxxxxxxx");
    assert.match(tampered.headers.get("location") ?? "", /\/login\?error=expired$/);
  });

  await step("POST without a same-site Origin is refused (CSRF)", async () => {
    const forged = { ...form({ email, password }), headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example.test", host: `127.0.0.1:${WEB_PORT}` } };
    assert.equal((await fetch(`${WEB}/session/login`, forged)).status, 403);
    const noOrigin = { ...form({ email, password }), headers: { "content-type": "application/x-www-form-urlencoded" } };
    assert.equal((await fetch(`${WEB}/session/logout`, noOrigin)).status, 403);
  });

  let registerFields;
  await step("registration creates the account, sets a hardened session cookie and never exposes the token in the page", async () => {
    const page = await (await get("/register")).text();
    const key = /name="idempotencyKey" value="([^"]+)"/.exec(page)?.[1];
    assert.match(key ?? "", /^[0-9a-f-]{36}$/);
    registerFields = { idempotencyKey: key, displayName: "E2E Admin", email, password, organizationName: orgName };
    const res = await fetch(`${WEB}/session/register`, form(registerFields));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/");
    const c = cookieOf(res);
    assert.ok(c, "session cookie missing");
    assert.match(c.raw, /^__Host-session=[A-Za-z0-9_-]{43};/);
    assert.match(c.raw, /HttpOnly/i);
    assert.match(c.raw, /Secure/i);
    assert.match(c.raw, /SameSite=lax/i);
    assert.match(c.raw, /Path=\//);
    assert.doesNotMatch(c.raw, /Domain=/i);
    session = { pair: c.pair, token: c.pair.split("=")[1] };
    const home = await html(await get("/", session.pair));
    assert.match(home, new RegExp(`Hola, E2E Admin`));
    assert.ok(home.includes(orgName));
    assert.ok(!home.includes(session.token), "token leaked into HTML");
  });

  await step("replaying the registration form (double submit) is idempotent: same session, no second account", async () => {
    const res = await fetch(`${WEB}/session/register`, form(registerFields));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/");
    assert.equal(cookieOf(res)?.pair, session.pair);
  });

  await step("registering the same email again with a new key fails with a generic message", async () => {
    const res = await fetch(`${WEB}/session/register`, form({ ...registerFields, idempotencyKey: randomUUID() }));
    assert.equal(res.headers.get("location"), "/register?error=conflict");
    const page = await (await get("/register?error=conflict")).text();
    assert.ok(!page.includes(email));
  });

  let itemId;
  const evilName = '<img src=x onerror="alert(1)">Widget';
  await step("catalog pages show API data, escape hostile content and ignore bad filters", async () => {
    const sku = `E2E-${randomUUID().slice(0, 6)}`;
    const created = await api("POST", "/catalog/items", session.token, { kind: "product", sku, name: evilName, features: [{ name: "Color", value: "<b>Red</b>" }] });
    assert.equal(created.status, 201);
    itemId = created.body.id;
    const draftList = await html(await get("/catalog", session.pair));
    assert.ok(draftList.includes(sku));
    assert.ok(!draftList.includes("<img src=x"), "raw HTML injected");
    assert.ok(draftList.includes("&lt;img src=x"));
    assert.ok(!(await html(await get("/catalog?status=approved", session.pair))).includes(sku));
    assert.equal((await api("POST", `/catalog/items/${itemId}/approve`, session.token)).status, 200);
    assert.ok((await html(await get("/catalog?status=approved&kind=product", session.pair))).includes(sku));
    assert.equal((await get("/catalog?status=%27%3B--&kind=<x>&cursor=../..", session.pair)).status, 200); // junk filters are dropped, not forwarded
    const detail = await html(await get(`/catalog/${itemId}`, session.pair));
    assert.ok(detail.includes("Contenido aprobado"));
    assert.ok(detail.includes("&lt;b&gt;Red&lt;/b&gt;"));
    assert.ok(!detail.includes("<b>Red</b>"));
  });

  await step("unknown or malformed item ids render 404, other pages work", async () => {
    assert.equal((await get(`/catalog/${randomUUID()}`, session.pair)).status, 404);
    assert.equal((await get("/catalog/not-an-id", session.pair)).status, 404);
    const company = await get("/company", session.pair);
    assert.equal(company.status, 200);
    assert.match(await html(company), /aún no se ha completado/);
  });

  const post = (path, fields, cookie, headers = {}) =>
    fetch(`${WEB}${path}`, { ...form(fields), headers: { ...form(fields).headers, ...(cookie ? { cookie } : {}), ...headers } });
  const where = (res) => res.headers.get("location");

  await step("W-02: an admin manages the catalog through the forms (create, edit, approve, version, archive, restore)", async () => {
    assert.equal(where(await post("/actions/catalog/categories", { name: "Hardware" }, session.pair)), "/catalog/categories?ok=category");
    assert.ok((await html(await get("/catalog/categories", session.pair))).includes("Hardware"));
    const categoryId = (await api("GET", "/catalog/categories", session.token)).body[0].id;
    assert.match(await html(await get("/catalog/new", session.pair)), /Crear borrador/);

    const sku = `W02-${randomUUID().slice(0, 6)}`;
    const created = await post("/actions/catalog/create", { kind: "product", sku, name: "Bomba", description: "Bomba centrífuga", unit: "pza", categoryId, features: "Color: Rojo\nPeso: 2 kg" }, session.pair);
    const id = /^\/catalog\/([0-9a-f-]{36})\?ok=created$/.exec(where(created))?.[1];
    assert.ok(id, `unexpected redirect ${where(created)}`);
    let page = await html(await get(`/catalog/${id}`, session.pair));
    for (const text of ["Aprobar borrador", "Archivar", "Editar borrador", "Hardware", "Color:"]) assert.ok(page.includes(text), `missing ${text}`);
    assert.ok(!page.includes("Restaurar"));

    assert.equal(where(await post(`/actions/catalog/${id}/update`, { name: "Bomba v1", description: "", unit: "pza", categoryId, features: "Color: Azul" }, session.pair)), `/catalog/${id}?ok=updated`);
    assert.equal(where(await post(`/actions/catalog/${id}/update`, { name: "x", features: "sin separador" }, session.pair)), `/catalog/${id}?error=input`);
    assert.ok((await html(await get(`/catalog/${id}`, session.pair))).includes("Bomba v1"));

    assert.equal(where(await post(`/actions/catalog/${id}/approve`, {}, session.pair)), `/catalog/${id}?ok=approve`);
    page = await html(await get(`/catalog/${id}`, session.pair));
    assert.ok(page.includes("Nueva versión (borrador)") && !page.includes("Aprobar borrador") && !page.includes("Editar borrador"));
    assert.equal(where(await post(`/actions/catalog/${id}/approve`, {}, session.pair)), `/catalog/${id}?error=conflict`);
    assert.equal(where(await post(`/actions/catalog/${id}/draft`, {}, session.pair)), `/catalog/${id}?ok=draft`);
    assert.equal(where(await post(`/actions/catalog/${id}/update`, { name: "Bomba v2", features: "" }, session.pair)), `/catalog/${id}?ok=updated`);
    assert.equal(where(await post(`/actions/catalog/${id}/approve`, {}, session.pair)), `/catalog/${id}?ok=approve`);
    assert.equal((await api("GET", `/catalog/items/${id}`, session.token)).body.approved.name, "Bomba v2");

    assert.equal(where(await post(`/actions/catalog/${id}/archive`, {}, session.pair)), `/catalog/${id}?ok=archive`);
    page = await html(await get(`/catalog/${id}`, session.pair));
    assert.ok(page.includes("Restaurar") && !page.includes("Archivar"));
    assert.equal(where(await post(`/actions/catalog/${id}/draft`, {}, session.pair)), `/catalog/${id}?error=conflict`);
    assert.equal(where(await post(`/actions/catalog/${id}/restore`, {}, session.pair)), `/catalog/${id}?ok=restore`);

    assert.equal((await post(`/actions/catalog/${id}/delete`, {}, session.pair)).status, 404); // unknown operations cannot reach the API
    assert.equal((await post("/actions/catalog/not-an-id/approve", {}, session.pair)).status, 404);
    assert.equal((await post(`/actions/catalog/${id}/archive`, {}, session.pair, { origin: "https://evil.example.test" })).status, 403);
    assert.equal((await api("GET", `/catalog/items/${id}`, session.token)).body.status, "approved"); // the forged request changed nothing
    assert.equal(where(await post("/actions/catalog/create", { kind: "product", sku, name: "dup" }, session.pair)), "/catalog/new?error=conflict");
    assert.equal(where(await post("/actions/catalog/create", { kind: "product", sku: "bad sku", name: "x" }, session.pair)), "/catalog/new?error=input");
    session.itemId = id;
  });

  await step("W-02: a viewer sees no write controls and forced requests are refused by the API", async () => {
    const admin = await api("GET", "/me", session.token);
    const viewerEmail = `viewer-${randomUUID().slice(0, 8)}@example.test`;
    const invite = await api("POST", "/invitations", session.token, { email: viewerEmail, role: "viewer" });
    assert.equal(invite.status, 201);
    const reg = await fetch(`${API}/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: viewerEmail, password, displayName: "Viewer", organizationName: `Viewer Home ${randomUUID().slice(0, 4)}` }) });
    const viewerToken = (await reg.json()).token;
    const accepted = await api("POST", "/invitations/accept", viewerToken, { token: invite.body.token });
    assert.equal(accepted.status, 200);

    const login = await fetch(`${WEB}/session/login`, form({ email: viewerEmail, password, organizationSlug: admin.body.organization.slug }));
    assert.equal(where(login), "/");
    const vc = cookieOf(login).pair;
    const id = session.itemId;
    const page = await html(await get(`/catalog/${id}`, vc));
    assert.ok(page.includes("Bomba v2"));
    for (const text of ["Archivar", "Aprobar borrador", "Nueva versión", "Editar borrador", "Restaurar"]) assert.ok(!page.includes(text), `viewer sees ${text}`);
    assert.match(await html(await get("/catalog/new", vc)), /no permite crear/);
    assert.ok(!(await html(await get("/catalog/categories", vc))).includes("Nueva categoría"));
    assert.ok(!(await html(await get("/catalog", vc))).includes("+ Nuevo elemento"));

    assert.equal(where(await post(`/actions/catalog/${id}/archive`, {}, vc)), `/catalog/${id}?error=forbidden`);
    assert.equal(where(await post("/actions/catalog/categories", { name: "Nope" }, vc)), "/catalog/categories?error=forbidden");
    assert.equal((await api("GET", `/catalog/items/${id}`, session.token)).body.status, "approved");
  });

  await step("wrong passwords show a generic error and the account throttle kicks in", async () => {
    const wrong = await fetch(`${WEB}/session/login`, form({ email, password: "definitely wrong password" }));
    assert.equal(wrong.headers.get("location"), "/login?error=invalid");
    const ghost = await fetch(`${WEB}/session/login`, form({ email: `nobody-${randomUUID().slice(0, 6)}@example.test`, password: "definitely wrong password" }));
    assert.equal(ghost.headers.get("location"), wrong.headers.get("location")); // no account enumeration
    for (let i = 0; i < 4; i++) await fetch(`${WEB}/session/login`, form({ email, password: "definitely wrong password" }));
    const blocked = await fetch(`${WEB}/session/login`, form({ email, password }));
    assert.equal(blocked.headers.get("location"), "/login?error=rate");
    assert.match(await html(await get("/login?error=rate")), /Demasiados intentos/);
  });

  await step("logout clears the cookie and revokes the token on the API", async () => {
    const res = await fetch(`${WEB}/session/logout`, { ...form({}), headers: { ...form({}).headers, cookie: session.pair } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/login");
    const cleared = cookieOf(res);
    assert.ok(cleared && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(cleared.raw));
    assert.equal((await api("GET", "/me", session.token)).status, 401);
    const after = await get("/", session.pair);
    assert.match(after.headers.get("location") ?? "", /\/login\?error=expired$/);
  });
} catch (e) {
  console.error(logs.filter((l) => /error|warn/i.test(l)).slice(-15).join("").slice(0, 3000));
  process.exitCode = 1;
  console.error(String(e?.message ?? e).slice(0, 600));
} finally {
  for (const c of children) c.kill();
  if (!process.exitCode) console.log(`\nE2E OK: ${passed} steps`);
}

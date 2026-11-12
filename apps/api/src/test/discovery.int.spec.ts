import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMBERSHIP_ROLES, OSM_ATTRIBUTION, ROLE_PERMISSIONS, type MembershipRole } from "@prospecting/contracts";
import { type Api, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** OSM discovery: preview, import with provenance, dedupe, do-not-contact, isolation, RBAC. Nominatim/Overpass are a local fake: no real network. */
let api: Api;
let fake: Server;
type Account = { token: string; orgId: string; userId: string };
type Seen = { at: number; method: string; path: string; userAgent: string; headers: Record<string, unknown>; query: string };
const seen: Seen[] = [];
let overpassDown = false;

const ELEMENTS: unknown[] = [
  { type: "node", id: 101, lat: 20.5931, lon: -100.3921, tags: { name: "Acme  Oficina\u0007", office: "company", website: "https://www.acme-osm.example.mx/", phone: "+52 442 123 4567", email: "Contacto@Acme-OSM.example.mx", "addr:street": "Av. Universidad", "addr:housenumber": "12", "addr:postcode": "76000", "addr:city": "Querétaro", operator: "Juan Pérez" } },
  { type: "way", id: 202, center: { lat: 20.59, lon: -100.39 }, tags: { name: "Taller López", craft: "carpenter", "contact:phone": "442 000 1111" } },
  { type: "node", id: 303, lat: 20.591, lon: -100.391, tags: { name: "Bloqueada SA", shop: "hardware", website: "bloqueada-osm.example.mx" } },
  { type: "node", id: 304, lat: 20.592, lon: -100.392, tags: { name: "No Llamar Nunca", shop: "bakery" } },
  // Hostile / malformed entries: must be dropped or neutralised, never trusted.
  { type: "node", id: 405, lat: 20.59, lon: -100.39, tags: { name: `Larga ${"x".repeat(5000)}`, shop: "kiosk", website: "javascript:alert(1)", phone: "<script>alert(1)</script>", email: "not-an-email", "addr:country": "Mexico" } },
  { type: "node", id: 406, lat: 999, lon: -100.39, tags: { name: "Coordenadas inválidas", shop: "kiosk" } },
  { type: "node", id: 407, lat: 20.59, lon: -100.39, tags: { shop: "kiosk" } },
  { type: "relation", id: 408, tags: { name: "Relación", shop: "mall" } },
  { type: "node", id: "409", lat: 20.59, lon: -100.39, tags: { name: "Id no numérico", shop: "kiosk" } },
  { type: "node", id: 410, lat: 20.59, lon: -100.39, tags: { name: "Página social", shop: "gift", website: "https://facebook.com/pagina-social" } },
  null,
  "garbage",
];

function startFake(): Promise<Server> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const query = url.pathname === "/interpreter" ? (new URLSearchParams(body).get("data") ?? "") : (url.searchParams.get("q") ?? "");
      seen.push({ at: Date.now(), method: req.method ?? "", path: url.pathname, userAgent: String(req.headers["user-agent"]), headers: req.headers, query });
      const json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (url.pathname === "/search") {
        if (query.startsWith("nowhere")) return json(200, []);
        if (query.startsWith("broken")) return res.writeHead(200).end("<html>not json");
        return json(200, [{ lat: "20.5931", lon: "-100.3921", display_name: `${query}, México`, address: { country_code: "mx" } }]);
      }
      if (url.pathname === "/interpreter") {
        if (overpassDown) return json(504, { remark: "timeout" });
        const ids = [...query.matchAll(/(node|way)\(id:([\d,]+)\)/g)].flatMap((m) => (m[2] as string).split(",").map((id) => `${m[1]}/${id}`));
        if (ids.length) return json(200, { elements: ELEMENTS.filter((e) => e && typeof e === "object" && ids.includes(`${(e as { type: string }).type}/${(e as { id: number }).id}`)) });
        const keys = ["office", "shop", "craft", "industrial"].filter((k) => query.includes(`["${k}"]`));
        return json(200, { elements: ELEMENTS.filter((e) => !e || typeof e !== "object" || keys.some((k) => k in ((e as { tags?: object }).tags ?? {}))) });
      }
      json(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function register(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label}` } });
  const me = await api.call("GET", "/me", { token: res.body.token });
  return { token: res.body.token, orgId: res.body.organization.id, userId: me.body.user.id };
}
async function member(orgId: string, role: MembershipRole) {
  const m = await seedMember(orgId, role);
  return (await api.call("POST", "/auth/login", { body: { email: m.email, password: PASSWORD } })).body.token as string;
}
const ALL = ["office", "shop", "craft", "industrial"];
const search = (t: string | undefined, body: Record<string, unknown> = {}) =>
  api.call("POST", "/prospects/discovery/search", { ...(t ? { token: t } : {}), body: { place: "Querétaro, México", radiusKm: 2, categories: ALL, ...body } });
const imp = (t: string | undefined, osmIds: string[], country: string | null = "MX") => api.call("POST", "/prospects/discovery/import", { ...(t ? { token: t } : {}), body: { osmIds, country } });
const prospectCount = async (orgId: string) => Number((await owner.query("SELECT count(*) AS n FROM prospects WHERE organization_id = $1", [orgId])).rows[0].n);
const suppress = (t: string, kind: "domain" | "name", value: string) => api.call("POST", "/suppressions", { token: t, body: { kind, value, reason: "Pidió no ser contactada" } });
const byId = (items: Array<{ osmId: string }>, id: string) => items.find((i) => i.osmId === id) as Record<string, unknown> | undefined;

beforeAll(async () => {
  fake = await startFake();
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.OSM_NOMINATIM_URL = base;
  process.env.OSM_OVERPASS_URL = `${base}/interpreter`;
  api = await startApi();
});
afterAll(async () => {
  await api.close();
  await new Promise((r) => fake.close(r));
});

describe("search (preview)", () => {
  it("returns validated businesses with attribution and stores nothing", async () => {
    const a = await register("osm-search");
    const from = seen.length;
    const res = await search(a.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: "openstreetmap", attribution: OSM_ATTRIBUTION, radiusKm: 2, truncated: false, place: { lat: 20.5931, lon: -100.3921, country: "MX" } });
    expect(res.body.items.map((i: { osmId: string }) => i.osmId).sort()).toEqual(["node/101", "node/303", "node/304", "node/405", "node/410", "way/202"]);
    expect(byId(res.body.items, "node/101")).toEqual({
      osmId: "node/101", name: "Acme Oficina", category: "office=company", address: "Av. Universidad 12, 76000", city: "Querétaro", region: null, country: "MX",
      phone: "+52 442 123 4567", website: "https://www.acme-osm.example.mx/", email: "contacto@acme-osm.example.mx", lat: 20.5931, lon: -100.3921,
      suppressed: false, alreadyExists: false, selectable: true,
    });
    expect(byId(res.body.items, "way/202")).toMatchObject({ name: "Taller López", category: "craft=carpenter", phone: "442 000 1111", lat: 20.59, lon: -100.39 });
    expect(await prospectCount(a.orgId)).toBe(0);

    const calls = seen.slice(from);
    expect(calls.every((c) => c.userAgent === "prospecting-saas/0.1")).toBe(true);
    expect(calls.every((c) => !("authorization" in c.headers) && !("cookie" in c.headers))).toBe(true);
    const overpass = calls.find((c) => c.path === "/interpreter") as Seen;
    expect(overpass.method).toBe("POST");
    expect(overpass.query).toContain('node["name"]["office"](around:2000,20.593100,-100.392100);');
    expect(overpass.query).toContain("out tags center 50;");
    expect(JSON.stringify(calls)).not.toContain(a.orgId);
  });

  it("treats provider data as untrusted: truncates, drops malformed entries and unsafe values", async () => {
    const a = await register("osm-untrusted");
    const res = await search(a.token);
    const long = byId(res.body.items, "node/405") as { name: string };
    expect(long.name.length).toBe(200);
    expect(long).toMatchObject({ website: null, phone: null, email: null, country: "MX" });
    expect(JSON.stringify(res.body)).not.toContain("Juan Pérez"); // person-related tags are never read
    expect(JSON.stringify(res.body)).not.toContain("script");
  });

  it("only asks for the requested categories and caps radius, limit and categories", async () => {
    const a = await register("osm-caps");
    const from = seen.length;
    const res = await search(a.token, { categories: ["craft"], limit: 100, radiusKm: 25 });
    expect(res.body.items.map((i: { osmId: string }) => i.osmId)).toEqual(["way/202"]);
    const q = (seen.slice(from).find((c) => c.path === "/interpreter") as Seen).query;
    expect(q).toContain("(around:25000,");
    expect(q).not.toContain('["shop"]');
    expect(q).toContain("out tags center 100;");
    for (const bad of [{ radiusKm: 25.1 }, { radiusKm: 0 }, { limit: 101 }, { categories: [] }, { categories: ["amenity"] }, { categories: ["shop", "shop"] }, { place: "x" }, { extra: 1 }]) {
      expect((await search(a.token, bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("answers 404 for an unknown place and 503 when a provider fails, without leaking provider output", async () => {
    const a = await register("osm-fail");
    expect((await search(a.token, { place: "nowhere at all" })).status).toBe(404);
    const broken = await search(a.token, { place: "broken geocoder" });
    expect(broken.status).toBe(503);
    expect(broken.body.code).toBe("UNAVAILABLE");
    overpassDown = true;
    try {
      const res = await search(a.token);
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toContain("timeout");
      expect((await imp(a.token, ["node/101"])).status).toBe(503);
      expect(await prospectCount(a.orgId)).toBe(0);
    } finally {
      overpassDown = false;
    }
  });

  it("sends at most one request per second to Nominatim", async () => {
    const a = await register("osm-rate");
    const from = seen.length;
    await Promise.all([search(a.token, { place: `Rate A ${randomUUID()}` }), search(a.token, { place: `Rate B ${randomUUID()}` }), search(a.token, { place: `Rate C ${randomUUID()}` })]);
    const times = seen.slice(from).filter((c) => c.path === "/search").map((c) => c.at).sort((x, y) => x - y);
    expect(times).toHaveLength(3);
    expect((times[1] as number) - (times[0] as number)).toBeGreaterThanOrEqual(950);
    expect((times[2] as number) - (times[1] as number)).toBeGreaterThanOrEqual(950);
  });
});

describe("import", () => {
  it("creates candidates with OpenStreetMap provenance, business attributes and an audit event", async () => {
    const a = await register("osm-import");
    const res = await imp(a.token, ["node/101", "way/202", "node/999"]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: "openstreetmap", attribution: OSM_ATTRIBUTION, created: 2, skippedDuplicate: 0, skippedSuppressed: 0, skippedNotFound: 1 });
    expect(res.body.items.map((i: { outcome: string }) => i.outcome)).toEqual(["created", "created", "not_found"]);
    const id = res.body.items[0].prospectId as string;

    const detail = await api.call("GET", `/prospects/${id}`, { token: a.token });
    expect(detail.body).toMatchObject({ name: "Acme Oficina", domain: "acme-osm.example.mx", country: "MX", city: "Querétaro", industry: "office=company", status: "candidate", contactPermission: "none", suppressed: false });
    expect(detail.body.sources).toHaveLength(1);
    expect(detail.body.sources[0]).toMatchObject({ type: "openstreetmap", ref: "node/101", createdBy: a.userId });
    expect(detail.body.sources[0].collectedAt).toBe(res.body.collectedAt);

    const row = (await owner.query("SELECT website FROM prospects WHERE id = $1", [id])).rows[0];
    expect(row.website).toBe("https://www.acme-osm.example.mx/");
    const attrs = (await owner.query("SELECT key, value, source, status, confidence FROM prospect_attributes WHERE prospect_id = $1 ORDER BY key", [id])).rows;
    expect(attrs).toEqual([
      { key: "address", value: "Av. Universidad 12, 76000", source: "openstreetmap", status: "unverified", confidence: "medium" },
      { key: "email", value: "contacto@acme-osm.example.mx", source: "openstreetmap", status: "unverified", confidence: "medium" },
      { key: "latitude", value: "20.593100", source: "openstreetmap", status: "unverified", confidence: "medium" },
      { key: "longitude", value: "-100.392100", source: "openstreetmap", status: "unverified", confidence: "medium" },
      { key: "phone", value: "+52 442 123 4567", source: "openstreetmap", status: "unverified", confidence: "medium" },
    ]);

    const audit = (await owner.query("SELECT metadata FROM audit_events WHERE organization_id = $1 AND action = 'prospect.discovery_imported'", [a.orgId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ source: "openstreetmap", attribution: OSM_ATTRIBUTION, requested: 3, created: 2, skippedNotFound: 1, createdOsmIds: ["node/101", "way/202"] });
    expect(JSON.stringify(audit[0].metadata)).not.toContain("Acme");
  });

  it("creates contacts without consent: email when valid, WhatsApp only for a safe E.164 phone; never duplicated", async () => {
    const a = await register("osm-contacts");
    const res = await imp(a.token, ["node/101", "way/202"]);
    const [withBoth, noContact] = res.body.items.map((i: { prospectId: string }) => i.prospectId) as string[];
    const rows = (await owner.query("SELECT channel, address, address_key, source, status FROM contacts WHERE prospect_id = $1 ORDER BY channel", [withBoth])).rows;
    expect(rows).toEqual([
      { channel: "email", address: "contacto@acme-osm.example.mx", address_key: "contacto@acme-osm.example.mx", source: "openstreetmap", status: "active" },
      { channel: "whatsapp", address: "+524421234567", address_key: "+524421234567", source: "openstreetmap", status: "active" },
    ]);
    // way/202 has a phone without country code: not safely normalizable, so no contact at all
    expect((await owner.query("SELECT 1 FROM contacts WHERE prospect_id = $1", [noContact])).rowCount).toBe(0);
    // intentional: no consent is recorded or assumed
    expect((await owner.query("SELECT 1 FROM consent_events WHERE organization_id = $1", [a.orgId])).rowCount).toBe(0);
    // repeating the discovery does not duplicate anything
    const again = await imp(a.token, ["node/101", "way/202"]);
    expect(again.body).toMatchObject({ created: 0, skippedDuplicate: 2 });
    expect((await owner.query("SELECT 1 FROM contacts WHERE organization_id = $1", [a.orgId])).rowCount).toBe(2);
  });

  it("rejects malformed requests", async () => {
    const a = await register("osm-badimport");
    for (const osmIds of [[], ["relation/1"], ["node/0"], ["node/1;drop"], ["node/1", "node/1"], Array.from({ length: 101 }, (_, i) => `node/${i + 1}`)]) {
      expect((await imp(a.token, osmIds)).status).toBe(400);
    }
    expect((await imp(a.token, ["node/101"], "mx")).status).toBe(400);
    expect(await prospectCount(a.orgId)).toBe(0);
  });

  it("dedupes against existing prospects and within the batch; a shared-host page is not a company identity", async () => {
    const a = await register("osm-dedupe");
    expect((await imp(a.token, ["node/101"])).body.created).toBe(1);
    const again = await imp(a.token, ["node/101", "way/202"]);
    expect(again.body).toMatchObject({ created: 1, skippedDuplicate: 1 });
    expect(again.body.items[0]).toEqual({ osmId: "node/101", outcome: "duplicate", prospectId: null });
    expect(await prospectCount(a.orgId)).toBe(2);
    expect((await owner.query("SELECT count(*) AS n FROM prospect_sources WHERE organization_id = $1", [a.orgId])).rows[0].n).toBe("2");

    const preview = await search(a.token);
    expect(byId(preview.body.items, "node/101")).toMatchObject({ alreadyExists: true, selectable: false });
    expect(byId(preview.body.items, "node/304")).toMatchObject({ alreadyExists: false, selectable: true });

    // A manually created prospect with the same name+country also counts as a duplicate.
    await api.call("POST", "/prospects", { token: a.token, body: { name: "página SOCIAL", country: "MX" } });
    const social = await imp(a.token, ["node/410"]);
    expect(social.body).toMatchObject({ created: 0, skippedDuplicate: 1 });
    expect((await owner.query("SELECT count(*) AS n FROM prospects WHERE organization_id = $1 AND domain_key = 'facebook.com'", [a.orgId])).rows[0].n).toBe("0");
  });

  it("respects the do-not-contact list: flagged in the preview, skipped and counted on import", async () => {
    const a = await register("osm-suppress");
    expect((await suppress(a.token, "domain", "bloqueada-osm.example.mx")).status).toBe(201);
    expect((await suppress(a.token, "name", "no llamar nunca")).status).toBe(201);

    const preview = await search(a.token);
    expect(byId(preview.body.items, "node/303")).toMatchObject({ suppressed: true, selectable: false });
    expect(byId(preview.body.items, "node/304")).toMatchObject({ suppressed: true, selectable: false });
    expect(byId(preview.body.items, "node/101")).toMatchObject({ suppressed: false, selectable: true });

    const res = await imp(a.token, ["node/303", "node/304", "node/101"]);
    expect(res.body).toMatchObject({ created: 1, skippedSuppressed: 2, skippedDuplicate: 0 });
    expect(res.body.items.map((i: { outcome: string }) => i.outcome)).toEqual(["suppressed", "suppressed", "created"]);
    expect(await prospectCount(a.orgId)).toBe(1);
    expect((await owner.query("SELECT count(*) AS n FROM prospects WHERE organization_id = $1 AND name IN ('Bloqueada SA', 'No Llamar Nunca')", [a.orgId])).rows[0].n).toBe("0");
  });
});

describe("isolation and permissions", () => {
  it("keeps two organizations apart: prospects, dedupe and suppression are per tenant", async () => {
    const a = await register("osm-iso-a");
    const b = await register("osm-iso-b");
    await suppress(a.token, "domain", "bloqueada-osm.example.mx");
    const inA = await imp(a.token, ["node/101", "node/303"]);
    expect(inA.body).toMatchObject({ created: 1, skippedSuppressed: 1 });

    const previewB = await search(b.token);
    expect(byId(previewB.body.items, "node/101")).toMatchObject({ alreadyExists: false, selectable: true });
    expect(byId(previewB.body.items, "node/303")).toMatchObject({ suppressed: false, selectable: true });
    const inB = await imp(b.token, ["node/101", "node/303"]);
    expect(inB.body).toMatchObject({ created: 2, skippedSuppressed: 0, skippedDuplicate: 0 });

    expect(await prospectCount(a.orgId)).toBe(1);
    expect(await prospectCount(b.orgId)).toBe(2);
    const idA = inA.body.items[0].prospectId as string;
    expect((await api.call("GET", `/prospects/${idA}`, { token: b.token })).status).toBe(404);
    expect((await api.call("GET", "/prospects?limit=100", { token: b.token })).body.items.map((p: { id: string }) => p.id)).not.toContain(idA);
    const orgs = (await owner.query("SELECT DISTINCT organization_id FROM prospect_attributes WHERE prospect_id = ANY($1::uuid[])", [inB.body.items.map((i: { prospectId: string }) => i.prospectId)])).rows;
    expect(orgs).toEqual([{ organization_id: b.orgId }]);
  });

  it("requires authentication and prospects:manage, exactly like the CSV import", async () => {
    const a = await register("osm-rbac");
    expect((await search(undefined)).status).toBe(401);
    expect((await imp(undefined, ["node/101"])).status).toBe(401);
    for (const role of MEMBERSHIP_ROLES) {
      const token = await member(a.orgId, role);
      const allowed = ROLE_PERMISSIONS[role].includes("prospects:manage");
      expect((await search(token)).status, `search as ${role}`).toBe(allowed ? 200 : 403);
      expect((await imp(token, ["node/999"])).status, `import as ${role}`).toBe(allowed ? 200 : 403);
    }
    expect(MEMBERSHIP_ROLES.some((r) => !ROLE_PERMISSIONS[r].includes("prospects:manage"))).toBe(true);
    expect(await prospectCount(a.orgId)).toBe(0);
  });
});

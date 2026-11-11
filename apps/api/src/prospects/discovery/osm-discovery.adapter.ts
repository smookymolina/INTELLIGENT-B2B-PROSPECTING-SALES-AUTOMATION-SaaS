import { Injectable } from "@nestjs/common";
import { DISCOVERY_CATEGORIES, DISCOVERY_LIMITS, normalizeDomain, type DiscoveryCategory } from "@prospecting/contracts";
import { ApiException } from "../../http/api-exception.js";

/** Generic client name on purpose: no user, tenant or contact data ever leaves in a request to OSM services. */
const USER_AGENT = "prospecting-saas/0.1";
const NOMINATIM_MIN_INTERVAL_MS = 1000; // Nominatim usage policy: at most 1 request per second
const NOMINATIM_TIMEOUT_MS = 10_000;
const OVERPASS_TIMEOUT_MS = 30_000;
const OVERPASS_QUERY_TIMEOUT_S = 25;
const MAX_BODY_BYTES = 5_000_000;
const GEOCODE_CACHE_MAX = 200;
const GEOCODE_CACHE_TTL_MS = 3_600_000;

export type OsmPlace = { label: string; lat: number; lon: number; country: string | null };
/** A business as published in OSM. Only whitelisted company tags are read; nothing about people is kept. */
export type OsmBusiness = {
  osmId: string; name: string; category: string; address: string | null; city: string | null; region: string | null; country: string | null;
  phone: string | null; website: string | null; domain: string | null; email: string | null; lat: number; lon: number;
};

const unavailable = (what: string) => new ApiException(503, "UNAVAILABLE", `The map data provider (${what}) is not available right now. Try again later.`);

function baseUrl(name: "OSM_NOMINATIM_URL" | "OSM_OVERPASS_URL", fallback: string): string {
  const raw = (process.env[name] ?? fallback).trim().replace(/\/+$/, "");
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${name} must be an http(s) URL`);
  return raw;
}

/* ---------- untrusted input cleaning ---------- */

/** Strips control characters, collapses whitespace and truncates. Returns null when nothing usable is left. */
export function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // Control, format (zero-width, bidi) and line/paragraph separator characters become spaces.
  const v = value.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
  return v ? v.slice(0, max).trim() : null;
}
/** Exactly two letters or nothing: a longer value ("Mexico") is never cut down to a wrong code. */
function iso2(value: unknown): string | null {
  const v = clean(value, 10)?.toUpperCase();
  return v && /^[A-Z]{2}$/.test(v) ? v : null;
}
const finite = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);

function cleanWebsite(value: unknown): { website: string; domain: string | null } | null {
  const raw = clean(value, 300);
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    const host = normalizeDomain(url.hostname);
    if (!host) return null;
    // A URL with a path is usually a page on a shared host (social network, directory): not an identity for the company.
    const own = url.pathname === "/" && !url.search;
    return { website: url.toString().slice(0, 300), domain: own ? host : null };
  } catch {
    return null;
  }
}
function cleanPhone(value: unknown): string | null {
  const v = clean(value, 60)?.split(";")[0]?.trim();
  return v && /^\+?[0-9][0-9 ()./-]{5,38}$/.test(v) ? v : null;
}
function cleanEmail(value: unknown): string | null {
  const v = clean(value, 200)?.split(";")[0]?.trim().toLowerCase();
  return v && /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,180}\.[a-z]{2,63}$/.test(v) ? v : null;
}

/** Maps one raw Overpass element to a business, or null when it is not a usable named company. */
export function toBusiness(el: unknown, categories: readonly DiscoveryCategory[], fallbackCountry: string | null): OsmBusiness | null {
  if (!el || typeof el !== "object") return null;
  const e = el as { type?: unknown; id?: unknown; lat?: unknown; lon?: unknown; center?: { lat?: unknown; lon?: unknown } | null; tags?: unknown };
  if ((e.type !== "node" && e.type !== "way") || typeof e.id !== "number" || !Number.isSafeInteger(e.id) || e.id <= 0) return null;
  if (!e.tags || typeof e.tags !== "object" || Array.isArray(e.tags)) return null;
  const tags = e.tags as Record<string, unknown>;
  const lat = finite(e.type === "node" ? e.lat : e.center?.lat, -90, 90);
  const lon = finite(e.type === "node" ? e.lon : e.center?.lon, -180, 180);
  const name = clean(tags.name, 200);
  const key = categories.find((c) => clean(tags[c], 60) !== null);
  if (lat === null || lon === null || !name || !key) return null;

  const street = clean(tags["addr:street"], 120);
  const number = clean(tags["addr:housenumber"], 20);
  const postcode = clean(tags["addr:postcode"], 20);
  const address = clean(tags["addr:full"], 200) ?? (street ? [[street, number].filter(Boolean).join(" "), postcode].filter(Boolean).join(", ").slice(0, 200) : null);
  const country = iso2(tags["addr:country"]);
  const site = cleanWebsite(tags.website ?? tags["contact:website"]);
  return {
    osmId: `${e.type}/${e.id}`,
    name,
    category: `${key}=${clean(tags[key], 60) as string}`,
    address,
    city: clean(tags["addr:city"], 100),
    region: clean(tags["addr:state"], 100),
    country: country ?? fallbackCountry,
    phone: cleanPhone(tags.phone ?? tags["contact:phone"]),
    website: site?.website ?? null,
    domain: site?.domain ?? null,
    email: cleanEmail(tags.email ?? tags["contact:email"]),
    lat,
    lon,
  };
}

/**
 * Adapter to the public OpenStreetMap services (no key; ODbL data). Responses are untrusted: size-capped, shape-checked and
 * truncated field by field. Base URLs are read per call so tests can point them at a local server.
 */
@Injectable()
export class OsmDiscoveryAdapter {
  private nominatimQueue: Promise<unknown> = Promise.resolve();
  private lastNominatimAt = 0;
  private readonly geocodeCache = new Map<string, { at: number; place: OsmPlace | null }>();

  /** Geocodes a free-text place. Returns null when Nominatim does not know it. */
  async geocode(place: string): Promise<OsmPlace | null> {
    const base = baseUrl("OSM_NOMINATIM_URL", "https://nominatim.openstreetmap.org");
    const cacheKey = `${base}|${place.toLowerCase()}`;
    const hit = this.geocodeCache.get(cacheKey);
    if (hit && Date.now() - hit.at < GEOCODE_CACHE_TTL_MS) return hit.place;

    const url = `${base}/search?${new URLSearchParams({ q: place, format: "jsonv2", limit: "1", addressdetails: "1" }).toString()}`;
    const json = await this.throttledNominatim(() => this.request("Nominatim", url, { method: "GET" }, NOMINATIM_TIMEOUT_MS));
    const first: unknown = Array.isArray(json) ? json[0] : null;
    let result: OsmPlace | null = null;
    if (first && typeof first === "object") {
      const r = first as { lat?: unknown; lon?: unknown; display_name?: unknown; address?: { country_code?: unknown } | null };
      const lat = finite(Number(r.lat), -90, 90);
      const lon = finite(Number(r.lon), -180, 180);
      const cc = iso2(r.address?.country_code);
      if (lat !== null && lon !== null && typeof r.lat === "string" && typeof r.lon === "string" && r.lat !== "" && r.lon !== "") {
        result = { label: clean(r.display_name, 200) ?? place, lat, lon, country: cc };
      }
    }
    if (this.geocodeCache.size >= GEOCODE_CACHE_MAX) this.geocodeCache.delete(this.geocodeCache.keys().next().value as string);
    this.geocodeCache.set(cacheKey, { at: Date.now(), place: result });
    return result;
  }

  /** Named nodes/ways carrying one of the category keys within `radiusKm` of the point. */
  async search(input: { lat: number; lon: number; radiusKm: number; categories: readonly DiscoveryCategory[]; limit: number; country: string | null }): Promise<{ items: OsmBusiness[]; truncated: boolean }> {
    const radius = Math.round(Math.min(input.radiusKm, DISCOVERY_LIMITS.maxRadiusKm) * 1000);
    const limit = Math.min(input.limit, DISCOVERY_LIMITS.maxResults);
    const categories = DISCOVERY_CATEGORIES.filter((c) => input.categories.includes(c));
    const around = `(around:${radius},${input.lat.toFixed(6)},${input.lon.toFixed(6)})`;
    const selectors = categories.flatMap((c) => [`node["name"]["${c}"]${around};`, `way["name"]["${c}"]${around};`]).join("");
    const elements = await this.overpass(`[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_S}];(${selectors});out tags center ${limit};`);
    return { items: this.businesses(elements, categories, input.country).slice(0, limit), truncated: elements.length >= limit };
  }

  /** Re-reads the selected elements from OSM so that what is stored is what OSM publishes, not what a client sent back. */
  async fetchByIds(osmIds: readonly string[], country: string | null): Promise<OsmBusiness[]> {
    const ids = osmIds.slice(0, DISCOVERY_LIMITS.maxImport).filter((id) => /^(node|way)\/[1-9]\d{0,18}$/.test(id));
    const of = (type: "node" | "way") => ids.filter((id) => id.startsWith(`${type}/`)).map((id) => id.slice(type.length + 1));
    const parts = (["node", "way"] as const).map((t) => (of(t).length ? `${t}(id:${of(t).join(",")});` : "")).join("");
    if (!parts) return [];
    const elements = await this.overpass(`[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_S}];(${parts});out tags center ${DISCOVERY_LIMITS.maxImport};`);
    const wanted = new Set(ids);
    return this.businesses(elements, DISCOVERY_CATEGORIES, country).filter((b) => wanted.has(b.osmId));
  }

  private businesses(elements: unknown[], categories: readonly DiscoveryCategory[], country: string | null): OsmBusiness[] {
    const seen = new Set<string>();
    const out: OsmBusiness[] = [];
    for (const el of elements.slice(0, DISCOVERY_LIMITS.maxResults * 2)) {
      const b = toBusiness(el, categories, country);
      if (!b || seen.has(b.osmId)) continue;
      seen.add(b.osmId);
      out.push(b);
    }
    return out;
  }

  private async overpass(query: string): Promise<unknown[]> {
    const base = baseUrl("OSM_OVERPASS_URL", "https://overpass-api.de/api/interpreter");
    const json = await this.request(
      "Overpass",
      base,
      { method: "POST", body: new URLSearchParams({ data: query }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } },
      OVERPASS_TIMEOUT_MS,
    );
    const elements = (json as { elements?: unknown } | null)?.elements;
    if (!Array.isArray(elements)) throw unavailable("Overpass");
    return elements;
  }

  /** Serialises Nominatim calls process-wide and spaces them at least one second apart. */
  private throttledNominatim<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.nominatimQueue.then(async () => {
      const wait = this.lastNominatimAt + NOMINATIM_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fn();
      } finally {
        this.lastNominatimAt = Date.now();
      }
    });
    this.nominatimQueue = run.catch(() => undefined);
    return run;
  }

  private async request(what: string, url: string, init: { method: string; body?: string; headers?: Record<string, string> }, timeoutMs: number): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method,
        body: init.body ?? null,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": USER_AGENT, accept: "application/json", ...init.headers },
      });
    } catch {
      throw unavailable(what);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw unavailable(what);
    }
    try {
      return JSON.parse(await readCapped(res, MAX_BODY_BYTES)) as unknown;
    } catch {
      throw unavailable(what);
    }
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

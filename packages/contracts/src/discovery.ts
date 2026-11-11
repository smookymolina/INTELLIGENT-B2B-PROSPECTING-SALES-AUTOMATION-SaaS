import { z } from "zod";

/* ---------- Geolocated company discovery (OpenStreetMap, ODbL) ---------- */

export const DISCOVERY_LIMITS = { maxRadiusKm: 25, maxResults: 100, maxImport: 100 } as const;
export const DISCOVERY_CATEGORIES = ["office", "shop", "craft", "industrial"] as const;
export type DiscoveryCategory = (typeof DISCOVERY_CATEGORIES)[number];
export const OSM_SOURCE = "openstreetmap";
/** ODbL requires this credit wherever the data is shown or stored. */
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

const osmId = z.string().regex(/^(node|way)\/[1-9]\d{0,18}$/);
const iso2 = z.string().regex(/^[A-Z]{2}$/);

export const DiscoverySearchRequest = z.strictObject({
  place: z.string().trim().min(2).max(200),
  radiusKm: z.number().min(0.1).max(DISCOVERY_LIMITS.maxRadiusKm),
  categories: z.array(z.enum(DISCOVERY_CATEGORIES)).min(1).max(DISCOVERY_CATEGORIES.length).refine((c) => new Set(c).size === c.length, "categories must not repeat"),
  limit: z.number().int().min(1).max(DISCOVERY_LIMITS.maxResults).default(50),
});
export type DiscoverySearchRequest = z.infer<typeof DiscoverySearchRequest>;

/** Business data only (never people). Every field comes from OSM, validated and truncated by the API. */
export const DiscoveryCandidateDto = z.object({
  osmId,
  name: z.string(),
  category: z.string(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  country: iso2.nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  email: z.string().nullable(),
  lat: z.number(),
  lon: z.number(),
  /** On the tenant's do-not-contact list: shown but never importable. */
  suppressed: z.boolean(),
  alreadyExists: z.boolean(),
  selectable: z.boolean(),
});
export type DiscoveryCandidateDto = z.infer<typeof DiscoveryCandidateDto>;

export const DiscoverySearchDto = z.object({
  source: z.literal(OSM_SOURCE),
  attribution: z.literal(OSM_ATTRIBUTION),
  place: z.object({ label: z.string(), lat: z.number(), lon: z.number(), country: iso2.nullable() }),
  radiusKm: z.number(),
  /** True when the provider returned as many results as the cap: there may be more. */
  truncated: z.boolean(),
  items: z.array(DiscoveryCandidateDto),
});
export type DiscoverySearchDto = z.infer<typeof DiscoverySearchDto>;

export const DiscoveryImportRequest = z.strictObject({
  osmIds: z.array(osmId).min(1).max(DISCOVERY_LIMITS.maxImport).refine((ids) => new Set(ids).size === ids.length, "osmIds must not repeat"),
  /** Country of the searched place (from the search response); used only when the OSM element has no `addr:country`. */
  country: iso2.nullish(),
});
export type DiscoveryImportRequest = z.infer<typeof DiscoveryImportRequest>;

export const DISCOVERY_OUTCOMES = ["created", "duplicate", "suppressed", "not_found"] as const;
export const DiscoveryImportDto = z.object({
  source: z.literal(OSM_SOURCE),
  attribution: z.literal(OSM_ATTRIBUTION),
  collectedAt: z.iso.datetime(),
  created: z.number().int(),
  skippedDuplicate: z.number().int(),
  skippedSuppressed: z.number().int(),
  skippedNotFound: z.number().int(),
  items: z.array(z.object({ osmId, outcome: z.enum(DISCOVERY_OUTCOMES), prospectId: z.uuid().nullable() })),
});
export type DiscoveryImportDto = z.infer<typeof DiscoveryImportDto>;

import { Inject, Injectable } from "@nestjs/common";
import {
  OSM_ATTRIBUTION,
  OSM_SOURCE,
  prospectKeys,
  type DiscoveryCandidateDto,
  type DiscoveryImportDto,
  type DiscoveryImportRequest,
  type DiscoverySearchDto,
  type DiscoverySearchRequest,
} from "@prospecting/contracts";
import { AuditService } from "../../audit/audit.service.js";
import type { AuthContext } from "../../auth/auth.types.js";
import { PrismaService } from "../../db/prisma.service.js";
import { ApiException } from "../../http/api-exception.js";
import { ProspectsService, type SuppressionSets } from "../prospects.service.js";
import { OsmDiscoveryAdapter, type OsmBusiness } from "./osm-discovery.adapter.js";

const TX_TIMEOUT_MS = 60_000;
type Keys = ReturnType<typeof prospectKeys>;

const keysOf = (b: OsmBusiness): Keys => prospectKeys(b.name, b.domain, b.country);
const isSuppressed = (k: Keys, sets: SuppressionSets) => (k.domainKey !== null && sets.domains.has(k.domainKey)) || sets.names.has(k.nameKey);

/**
 * Geolocated discovery of companies from OpenStreetMap. The preview stores nothing; the import follows the CSV import rules
 * (tenant transaction, dedupe key, provenance row, audit) and additionally skips anything on the do-not-contact list.
 * Imported prospects stay `candidate`: discovery never implies permission to contact.
 */
@Injectable()
export class DiscoveryService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ProspectsService) private readonly prospects: ProspectsService,
    @Inject(OsmDiscoveryAdapter) private readonly osm: OsmDiscoveryAdapter,
  ) {}

  async search(auth: AuthContext, input: DiscoverySearchRequest): Promise<DiscoverySearchDto> {
    const place = await this.osm.geocode(input.place);
    if (!place) throw new ApiException(404, "NOT_FOUND", "That place was not found. Try a more specific name (city, state, country).");
    const found = await this.osm.search({ lat: place.lat, lon: place.lon, radiusKm: input.radiusKm, categories: input.categories, limit: input.limit, country: place.country });
    const keyed = found.items.map((b) => ({ b, k: keysOf(b) }));

    const { sets, existing } = await this.db.withTenant(auth, async (tx) => ({
      sets: await this.prospects.suppressionSets(tx, auth),
      existing: keyed.length
        ? new Set((await tx.prospect.findMany({ where: { organization_id: auth.organizationId, dedupe_key: { in: keyed.map((x) => x.k.dedupeKey) } }, select: { dedupe_key: true } })).map((p) => p.dedupe_key))
        : new Set<string>(),
    }));

    const items: DiscoveryCandidateDto[] = keyed.map(({ b, k }) => {
      const suppressed = isSuppressed(k, sets);
      const alreadyExists = existing.has(k.dedupeKey);
      return {
        osmId: b.osmId, name: b.name, category: b.category, address: b.address, city: b.city, region: b.region, country: b.country,
        phone: b.phone, website: b.website, email: b.email, lat: b.lat, lon: b.lon, suppressed, alreadyExists, selectable: !suppressed && !alreadyExists,
      };
    });
    return { source: OSM_SOURCE, attribution: OSM_ATTRIBUTION, place, radiusKm: input.radiusKm, truncated: found.truncated, items };
  }

  async import(auth: AuthContext, input: DiscoveryImportRequest): Promise<DiscoveryImportDto> {
    const businesses = await this.osm.fetchByIds(input.osmIds, input.country ?? null);
    const byId = new Map(businesses.map((b) => [b.osmId, b]));
    const collectedAt = new Date();

    try {
      return await this.db.withTenant(
        auth,
        async (tx) => {
          const sets = await this.prospects.suppressionSets(tx, auth);
          const keyed = input.osmIds.map((osmId) => {
            const b = byId.get(osmId);
            return { osmId, b, k: b ? keysOf(b) : null };
          });
          const dedupeKeys = keyed.flatMap((x) => (x.k ? [x.k.dedupeKey] : []));
          const taken = new Set(
            dedupeKeys.length
              ? (await tx.prospect.findMany({ where: { organization_id: auth.organizationId, dedupe_key: { in: dedupeKeys } }, select: { dedupe_key: true } })).map((p) => p.dedupe_key)
              : [],
          );

          const items: DiscoveryImportDto["items"] = [];
          for (const { osmId, b, k } of keyed) {
            if (!b || !k) {
              items.push({ osmId, outcome: "not_found", prospectId: null });
            } else if (isSuppressed(k, sets)) {
              items.push({ osmId, outcome: "suppressed", prospectId: null });
            } else if (taken.has(k.dedupeKey)) {
              items.push({ osmId, outcome: "duplicate", prospectId: null });
            } else {
              taken.add(k.dedupeKey); // also dedupes within the batch (e.g. two branches sharing one website)
              const row = await tx.prospect.create({
                data: {
                  organization_id: auth.organizationId, name: b.name, name_key: k.nameKey, domain_key: k.domainKey, dedupe_key: k.dedupeKey, website: b.website,
                  country: b.country, region: b.region, city: b.city, industry: b.category.slice(0, 100), created_by: auth.userId,
                },
              });
              await tx.prospectSource.create({
                data: { organization_id: auth.organizationId, prospect_id: row.id, source_type: OSM_SOURCE, source_ref: b.osmId, created_by: auth.userId, collected_at: collectedAt },
              });
              const attributes: Array<[string, string | null]> = [
                ["address", b.address], ["phone", b.phone], ["email", b.email], ["latitude", b.lat.toFixed(6)], ["longitude", b.lon.toFixed(6)],
              ];
              for (const [key, raw] of attributes) {
                const value = raw?.slice(0, 200).trim();
                if (!value) continue;
                // value_key is computed by PostgreSQL so it always satisfies the table's lower(btrim(value)) check.
                await tx.$executeRaw`
                  INSERT INTO prospect_attributes (organization_id, prospect_id, key, value, value_key, confidence, source, created_by)
                  VALUES (${auth.organizationId}::uuid, ${row.id}::uuid, ${key}, btrim(${value}), lower(btrim(${value})), 'medium', ${OSM_SOURCE}, ${auth.userId}::uuid)`;
              }
              items.push({ osmId, outcome: "created", prospectId: row.id });
            }
          }

          const count = (o: DiscoveryImportDto["items"][number]["outcome"]) => items.filter((i) => i.outcome === o).length;
          const totals = { created: count("created"), skippedDuplicate: count("duplicate"), skippedSuppressed: count("suppressed"), skippedNotFound: count("not_found") };
          // Audit records provenance and counts, never the business data itself.
          await this.audit.record(tx, auth, {
            action: "prospect.discovery_imported", resourceType: "prospects",
            metadata: { source: OSM_SOURCE, attribution: OSM_ATTRIBUTION, collectedAt: collectedAt.toISOString(), requested: input.osmIds.length, ...totals, createdOsmIds: items.filter((i) => i.outcome === "created").map((i) => i.osmId) },
          });
          return { source: OSM_SOURCE, attribution: OSM_ATTRIBUTION, collectedAt: collectedAt.toISOString(), ...totals, items };
        },
        { timeoutMs: TX_TIMEOUT_MS },
      );
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw new ApiException(409, "CONFLICT", "The prospect list changed while importing; nothing was applied. Retry the import.");
      throw e;
    }
  }
}

import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  normalizeDomain,
  normalizeNameKey,
  prospectKeys,
  type ConnectorsDto,
  type CreateProspectRequest,
  type CreateSuppressionRequest,
  type ProspectDetailDto,
  type ProspectDto,
  type ProspectExportQuery,
  type ProspectListQuery,
  type ProspectPageDto,
  type SetProspectStatusRequest,
  type SuppressionDto,
  type SuppressionListDto,
  type UpdateProspectRequest,
} from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService, type Tx } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";
import { EXPORT_MAX_ROWS, toCsv } from "../http/csv.js";

const isUnique = (e: unknown) => (e as { code?: string }).code === "P2002";
const suppressedByTrigger = (e: unknown) => String((e as { message?: string }).message ?? "").includes("suppressed prospect");
const conflict = (message: string, details: unknown = null) => new ApiException(409, "CONFLICT", message, details);
const MAX_SUPPRESSIONS = 5000;

type Row = {
  id: string; name: string; name_key: string; domain_key: string | null; country: string | null; region: string | null; city: string | null; industry: string | null;
  notes: string | null; status: ProspectDto["status"]; status_reason: string | null; created_at: Date; updated_at: Date;
};
export type SuppressionSets = { domains: Set<string>; names: Set<string> };

export const prospectDto = (r: Row, sets: SuppressionSets): ProspectDto => ({
  id: r.id, name: r.name, domain: r.domain_key, country: r.country, region: r.region, city: r.city, industry: r.industry, notes: r.notes,
  status: r.status, statusReason: r.status_reason, suppressed: (r.domain_key !== null && sets.domains.has(r.domain_key)) || sets.names.has(r.name_key),
  contactPermission: "none", createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});

/** Prospecting connectors are adapters to external data sources. None exists until a provider is approved (terms, quotas, credentials). */
const CONNECTORS: ConnectorsDto = {
  connectors: [],
  note: "No prospecting connector is enabled. Prospects come from manual entry or CSV import until a provider is approved and configured.",
};

@Injectable()
export class ProspectsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  connectors(): ConnectorsDto {
    return CONNECTORS;
  }

  /* ---------- prospects ---------- */

  list(auth: AuthContext, q: ProspectListQuery): Promise<ProspectPageDto> {
    return this.db.withTenant(auth, async (tx) => {
      const sets = await this.suppressionSets(tx, auth);
      const needle = q.q ? normalizeNameKey(q.q) : null;
      const rows = await tx.prospect.findMany({
        where: {
          organization_id: auth.organizationId,
          ...(q.status !== "all" ? { status: q.status } : {}),
          ...(q.country ? { country: q.country } : {}),
          merges_as_duplicate: { none: { reverted_at: null } }, // hidden duplicates (see ProspectMergeService)
          ...(needle ? { OR: [{ name_key: { startsWith: needle } }, { domain_key: { startsWith: needle } }] } : {}),
          ...(q.cursor ? { id: { gt: q.cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: q.suppressed ? 1000 : q.limit + 1, // the suppressed filter is evaluated against the live list below
      });
      let dtos = rows.map((r) => prospectDto(r, sets));
      if (q.suppressed) dtos = dtos.filter((d) => d.suppressed === (q.suppressed === "true"));
      const page = dtos.slice(0, q.limit);
      return { items: page, nextCursor: dtos.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
    });
  }

  /** CSV of prospects with the live do-not-contact flag. Capped and audited like every export. */
  exportCsv(auth: AuthContext, q: ProspectExportQuery): Promise<{ csv: string; truncated: boolean }> {
    return this.db.withTenant(auth, async (tx) => {
      const sets = await this.suppressionSets(tx, auth);
      const rows = await tx.prospect.findMany({
        where: { organization_id: auth.organizationId, ...(q.status !== "all" ? { status: q.status } : {}), ...(q.country ? { country: q.country } : {}), merges_as_duplicate: { none: { reverted_at: null } } },
        orderBy: { id: "asc" },
        take: EXPORT_MAX_ROWS + 1,
      });
      const truncated = rows.length > EXPORT_MAX_ROWS;
      const kept = rows.slice(0, EXPORT_MAX_ROWS);
      await this.audit.record(tx, auth, { action: "export.created", resourceType: "prospects", metadata: { status: q.status, country: q.country ?? null, rows: kept.length, truncated } });
      return {
        csv: toCsv(
          ["id", "name", "domain", "website", "country", "region", "city", "industry", "status", "do_not_contact", "created_at"],
          kept.map((r) => [r.id, r.name, r.domain_key, r.website, r.country, r.region, r.city, r.industry, r.status, prospectDto(r, sets).suppressed, r.created_at.toISOString()]),
        ),
        truncated,
      };
    });
  }

  get(auth: AuthContext, id: string): Promise<ProspectDetailDto> {
    return this.db.withTenant(auth, async (tx) => {
      const row = await tx.prospect.findFirst({ where: { id, organization_id: auth.organizationId } });
      if (!row) throw new NotFoundException();
      const [sets, sources] = await Promise.all([
        this.suppressionSets(tx, auth),
        tx.prospectSource.findMany({ where: { organization_id: auth.organizationId, prospect_id: id }, orderBy: [{ collected_at: "asc" }, { id: "asc" }] }),
      ]);
      return {
        ...prospectDto(row, sets),
        sources: sources.map((s) => ({ id: s.id, type: s.source_type as "manual" | "csv_import", ref: s.source_ref, collectedAt: s.collected_at.toISOString(), createdBy: s.created_by })),
      };
    });
  }

  async create(auth: AuthContext, input: CreateProspectRequest): Promise<ProspectDto> {
    const keys = prospectKeys(input.name, input.domain, input.country);
    try {
      return await this.db.withTenant(auth, async (tx) => {
        const row = await tx.prospect.create({
          data: {
            organization_id: auth.organizationId, name: input.name, name_key: keys.nameKey, domain_key: keys.domainKey, dedupe_key: keys.dedupeKey,
            country: input.country ?? null, region: input.region ?? null, city: input.city ?? null, industry: input.industry ?? null, notes: input.notes ?? null,
            created_by: auth.userId,
          },
        });
        await tx.prospectSource.create({ data: { organization_id: auth.organizationId, prospect_id: row.id, source_type: "manual", created_by: auth.userId } });
        await this.audit.record(tx, auth, { action: "prospect.created", resourceType: "prospect", resourceId: row.id, metadata: { source: "manual" } });
        return prospectDto(row, await this.suppressionSets(tx, auth));
      });
    } catch (e) {
      if (isUnique(e)) throw await this.duplicate(auth, keys.dedupeKey);
      throw e;
    }
  }

  async update(auth: AuthContext, id: string, input: UpdateProspectRequest): Promise<ProspectDto> {
    let targetKey = "";
    try {
      return await this.db.withTenant(auth, async (tx) => {
        const current = await tx.prospect.findFirst({ where: { id, organization_id: auth.organizationId } });
        if (!current) throw new NotFoundException();
        const name = input.name ?? current.name;
        const domain = input.domain !== undefined ? input.domain : current.domain_key;
        const country = input.country !== undefined ? input.country : current.country;
        const keys = prospectKeys(name, domain, country);
        targetKey = keys.dedupeKey;
        const row = await tx.prospect.update({
          where: { id },
          data: {
            name, name_key: keys.nameKey, domain_key: keys.domainKey, dedupe_key: keys.dedupeKey, country,
            ...(input.region !== undefined ? { region: input.region } : {}), ...(input.city !== undefined ? { city: input.city } : {}),
            ...(input.industry !== undefined ? { industry: input.industry } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}),
          },
        });
        await this.audit.record(tx, auth, { action: "prospect.updated", resourceType: "prospect", resourceId: id, metadata: { changedFields: Object.keys(input) } });
        return prospectDto(row, await this.suppressionSets(tx, auth));
      });
    } catch (e) {
      if (isUnique(e)) throw await this.duplicate(auth, targetKey);
      if (suppressedByTrigger(e)) throw conflict("The new domain or name is on the do-not-contact list");
      throw e;
    }
  }

  setStatus(auth: AuthContext, id: string, input: SetProspectStatusRequest): Promise<ProspectDto> {
    return this.db.withTenant(auth, async (tx) => {
      const current = await tx.prospect.findFirst({ where: { id, organization_id: auth.organizationId } });
      if (!current) throw new NotFoundException();
      const sets = await this.suppressionSets(tx, auth);
      if (input.status === "qualified" && prospectDto(current, sets).suppressed) throw conflict("A prospect on the do-not-contact list cannot be qualified");
      const row = await tx.prospect.update({
        where: { id },
        data: { status: input.status, status_reason: input.status === "disqualified" ? (input.reason ?? null) : null },
      });
      await this.audit.record(tx, auth, {
        action: "prospect.status_changed", resourceType: "prospect", resourceId: id, metadata: { from: current.status, to: input.status },
      });
      return prospectDto(row, sets);
    });
  }

  /* ---------- do-not-contact list ---------- */

  listSuppressions(auth: AuthContext): Promise<SuppressionListDto> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.suppression.findMany({ where: { organization_id: auth.organizationId }, orderBy: [{ created_at: "desc" }, { id: "asc" }], take: MAX_SUPPRESSIONS });
      return { items: rows.map(suppressionDto) };
    });
  }

  async createSuppression(auth: AuthContext, input: CreateSuppressionRequest): Promise<SuppressionDto> {
    const valueKey = input.kind === "domain" ? (normalizeDomain(input.value) as string) : normalizeNameKey(input.value);
    try {
      return await this.db.withTenant(auth, async (tx) => {
        if ((await tx.suppression.count({ where: { organization_id: auth.organizationId } })) >= MAX_SUPPRESSIONS) throw conflict("The do-not-contact list is full");
        const affected = await tx.prospect.count({
          where: { organization_id: auth.organizationId, status: "qualified", ...(input.kind === "domain" ? { domain_key: valueKey } : { name_key: valueKey }) },
        });
        const row = await tx.suppression.create({ data: { organization_id: auth.organizationId, kind: input.kind, value_key: valueKey, reason: input.reason, created_by: auth.userId } });
        await this.audit.record(tx, auth, {
          action: "suppression.created", resourceType: "suppression", resourceId: row.id, metadata: { kind: input.kind, disqualifiedProspects: affected },
        });
        return suppressionDto(row);
      });
    } catch (e) {
      throw isUnique(e) ? conflict("That entry is already on the list") : e;
    }
  }

  removeSuppression(auth: AuthContext, id: string): Promise<void> {
    return this.db.withTenant(auth, async (tx) => {
      const row = await tx.suppression.findFirst({ where: { id, organization_id: auth.organizationId } });
      if (!row) throw new NotFoundException();
      const removed = await tx.suppression.deleteMany({ where: { id, organization_id: auth.organizationId } });
      if (removed.count === 0) throw new NotFoundException();
      await this.audit.record(tx, auth, { action: "suppression.removed", resourceType: "suppression", resourceId: id, metadata: { kind: row.kind, value: row.value_key } });
    });
  }

  /** Shared with the CSV import: the live do-not-contact sets of the tenant. */
  async suppressionSets(tx: Tx, auth: AuthContext): Promise<SuppressionSets> {
    const rows = await tx.suppression.findMany({ where: { organization_id: auth.organizationId }, select: { kind: true, value_key: true }, take: MAX_SUPPRESSIONS });
    return { domains: new Set(rows.filter((r) => r.kind === "domain").map((r) => r.value_key)), names: new Set(rows.filter((r) => r.kind === "name").map((r) => r.value_key)) };
  }

  private async duplicate(auth: AuthContext, dedupeKey: string): Promise<ApiException> {
    const existing = await this.db.withTenant(auth, (tx) => tx.prospect.findFirst({ where: { organization_id: auth.organizationId, dedupe_key: dedupeKey }, select: { id: true } }));
    return conflict("That prospect already exists", { existingId: existing?.id ?? null });
  }
}

const suppressionDto = (r: { id: string; kind: string; value_key: string; reason: string; created_at: Date }): SuppressionDto => ({
  id: r.id, kind: r.kind as "domain" | "name", value: r.value_key, reason: r.reason, createdAt: r.created_at.toISOString(),
});

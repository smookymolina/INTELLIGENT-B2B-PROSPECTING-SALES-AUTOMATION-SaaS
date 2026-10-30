import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  IMPORT_LIMITS,
  ProspectImportRow,
  prospectKeys,
  type ImportRequest,
  type PageQuery,
  type ProspectImportErrorDto,
  type ProspectImportJobDto,
  type ProspectImportJobPageDto,
  type ProspectImportResultDto,
} from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { CsvError, parseCsv } from "../catalog/csv.js";
import { PrismaService, type Prisma } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";

const COLUMNS = ["name", "domain", "country", "region", "city", "industry"] as const;
const TX_TIMEOUT_MS = 120_000;
type Action = "create" | "update" | "unchanged";
type Plan = { row: number; name: string; action: Action; data: ProspectImportRow; id?: string; existing?: { name: string; region: string | null; city: string | null; industry: string | null } };

const badFile = (code: string, extra: Record<string, unknown> = {}) => new ApiException(400, "VALIDATION_FAILED", "Validation failed", { issues: [{ path: "csv", code, ...extra }] });

/** Same guarantees as the catalog import: dry run, all-or-nothing, idempotent by content, immutable job record, no echo of cell values. */
@Injectable()
export class ProspectImportService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async run(auth: AuthContext, input: ImportRequest): Promise<ProspectImportResultDto> {
    const records = this.parse(input.csv);
    const index = this.layout(records[0] as string[]);
    const fileHash = createHash("sha256").update(input.csv, "utf8").digest("hex");
    const jobId = randomUUID();

    try {
      return await this.db.withTenant(
        auth,
        async (tx) => {
          const errors: ProspectImportErrorDto[] = [];
          const errorRows: Array<{ row: number; name: string | null }> = [];
          const parsed: Array<{ row: number; data: ProspectImportRow; dedupeKey: string; nameKey: string; domainKey: string | null }> = [];
          const seen = new Map<string, number>();

          records.slice(1).forEach((cells, i) => {
            const row = i + 2;
            const cell = (c: string) => {
              const at = index.get(c);
              const v = at === undefined ? undefined : cells[at]?.trim();
              return v ? v : undefined;
            };
            const name = cell("name") ?? null;
            const fail = (code: string, message: string, column: string | null = null) => {
              errors.push({ row, name, column, code, message });
              if (!errorRows.some((r) => r.row === row)) errorRows.push({ row, name });
            };
            if (cells.length !== index.size) return fail("column_count", `Expected ${index.size} columns but found ${cells.length}`);
            const result = ProspectImportRow.safeParse({ name: cell("name"), domain: cell("domain"), country: cell("country")?.toUpperCase(), region: cell("region"), city: cell("city"), industry: cell("industry") });
            if (!result.success) {
              for (const issue of result.error.issues) fail(issue.code, issue.message, String(issue.path[0] ?? "") || null);
              return;
            }
            const keys = prospectKeys(result.data.name, result.data.domain, result.data.country);
            const earlier = seen.get(keys.dedupeKey);
            if (earlier !== undefined) return fail("duplicate_in_file", `Same prospect as row ${earlier}`, "name");
            seen.set(keys.dedupeKey, row);
            parsed.push({ row, data: result.data, ...keys });
          });

          const existing = parsed.length
            ? await tx.prospect.findMany({ where: { organization_id: auth.organizationId, dedupe_key: { in: parsed.map((p) => p.dedupeKey) } } })
            : [];
          const byKey = new Map(existing.map((p) => [p.dedupe_key, p]));
          const plans: Plan[] = parsed.map((p) => {
            const found = byKey.get(p.dedupeKey);
            if (!found) return { row: p.row, name: p.data.name, action: "create", data: p.data };
            const managed = (col: string) => index.has(col);
            const same =
              found.name === p.data.name &&
              (!managed("region") || found.region === (p.data.region ?? null)) &&
              (!managed("city") || found.city === (p.data.city ?? null)) &&
              (!managed("industry") || found.industry === (p.data.industry ?? null));
            return { row: p.row, name: p.data.name, action: same ? "unchanged" : "update", data: p.data, id: found.id, existing: found };
          });

          const counts = { created: 0, updated: 0, unchanged: 0 };
          for (const p of plans) counts[p.action === "create" ? "created" : p.action === "update" ? "updated" : "unchanged"]++;
          const hasErrors = errors.length > 0;
          let status: ProspectImportJobDto["status"];
          let shown = counts;
          if (input.mode === "dry_run") status = hasErrors ? "invalid" : "valid";
          else if (hasErrors) {
            status = "rejected";
            shown = { created: 0, updated: 0, unchanged: 0 };
          } else {
            status = "applied";
          }

          errors.sort((a, b) => a.row - b.row);
          const job = await tx.importJob.create({
            data: {
              id: jobId, organization_id: auth.organizationId, kind: "prospects", mode: input.mode, status, file_hash: fileHash, total_rows: records.length - 1,
              created_count: shown.created, updated_count: shown.updated, unchanged_count: shown.unchanged, error_count: errors.length,
              errors: errors.slice(0, IMPORT_LIMITS.maxReportedErrors) as unknown as Prisma.InputJsonValue, created_by: auth.userId,
            },
          });

          if (status === "applied") {
            for (const p of plans) {
              if (p.action === "create") {
                const keys = prospectKeys(p.data.name, p.data.domain, p.data.country);
                const created = await tx.prospect.create({
                  data: {
                    organization_id: auth.organizationId, name: p.data.name, name_key: keys.nameKey, domain_key: keys.domainKey, dedupe_key: keys.dedupeKey,
                    country: p.data.country ?? null, region: p.data.region ?? null, city: p.data.city ?? null, industry: p.data.industry ?? null, created_by: auth.userId,
                  },
                });
                await tx.prospectSource.create({ data: { organization_id: auth.organizationId, prospect_id: created.id, source_type: "csv_import", source_ref: jobId, created_by: auth.userId } });
              } else if (p.action === "update" && p.id) {
                await tx.prospect.update({
                  where: { id: p.id },
                  data: {
                    name: p.data.name,
                    ...(index.has("region") ? { region: p.data.region ?? null } : {}),
                    ...(index.has("city") ? { city: p.data.city ?? null } : {}),
                    ...(index.has("industry") ? { industry: p.data.industry ?? null } : {}),
                  },
                });
                await tx.prospectSource.create({ data: { organization_id: auth.organizationId, prospect_id: p.id, source_type: "csv_import", source_ref: jobId, created_by: auth.userId } });
              }
            }
          }
          if (input.mode === "apply") {
            await this.audit.record(tx, auth, {
              action: status === "applied" ? "prospect.import_applied" : "prospect.import_rejected", resourceType: "import_job", resourceId: jobId,
              metadata: { ...shown, errors: errors.length, fileHash },
            });
          }
          return {
            ...dto(job),
            rows: [
              ...plans.map((p) => ({ row: p.row, name: p.name, action: p.action })),
              ...errorRows.map((r) => ({ row: r.row, name: r.name, action: "error" as const })),
            ].sort((a, b) => a.row - b.row),
          };
        },
        { timeoutMs: TX_TIMEOUT_MS },
      );
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw new ApiException(409, "CONFLICT", "The prospect list changed while importing; nothing was applied. Retry the import.");
      throw e;
    }
  }

  listJobs(auth: AuthContext, q: PageQuery): Promise<ProspectImportJobPageDto> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.importJob.findMany({
        where: { organization_id: auth.organizationId, kind: "prospects", ...(q.cursor ? { id: { gt: q.cursor } } : {}) },
        orderBy: { id: "asc" },
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      return { items: page.map(dto), nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
    });
  }

  getJob(auth: AuthContext, id: string): Promise<ProspectImportJobDto> {
    return this.db.withTenant(auth, async (tx) => {
      const job = await tx.importJob.findFirst({ where: { id, organization_id: auth.organizationId, kind: "prospects" } });
      if (!job) throw new NotFoundException();
      return dto(job);
    });
  }

  private parse(csv: string): string[][] {
    try {
      const records = parseCsv(csv, { maxRows: IMPORT_LIMITS.maxRows, maxColumns: IMPORT_LIMITS.maxColumns, maxFieldLength: IMPORT_LIMITS.maxFieldLength });
      if (records.length < 2) throw badFile("no_data_rows");
      return records;
    } catch (e) {
      if (e instanceof CsvError) throw badFile(e.code, e.line ? { line: e.line } : {});
      throw e;
    }
  }

  private layout(header: string[]): Map<string, number> {
    const index = new Map<string, number>();
    header.forEach((raw, i) => {
      const name = raw.trim().toLowerCase();
      if (index.has(name)) throw badFile("duplicate_column", { column: raw.trim().slice(0, 80) });
      if (!(COLUMNS as readonly string[]).includes(name)) throw badFile("unknown_column", { column: raw.trim().slice(0, 80) });
      index.set(name, i);
    });
    if (!index.has("name")) throw badFile("missing_column", { column: "name" });
    return index;
  }
}

function dto(j: {
  id: string; mode: string; status: string; file_hash: string; total_rows: number; created_count: number; updated_count: number;
  unchanged_count: number; error_count: number; errors: Prisma.JsonValue; created_by: string; created_at: Date;
}): ProspectImportJobDto {
  const errors = j.errors as unknown as ProspectImportErrorDto[];
  return {
    id: j.id, mode: j.mode as ProspectImportJobDto["mode"], status: j.status as ProspectImportJobDto["status"], fileHash: j.file_hash,
    totals: { rows: j.total_rows, created: j.created_count, updated: j.updated_count, unchanged: j.unchanged_count, errors: j.error_count },
    errors, errorsTruncated: j.error_count > errors.length, createdBy: j.created_by, createdAt: j.created_at.toISOString(),
  };
}

import { createHash } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  IMPORT_LIMITS,
  ImportRow,
  type CreateItemRequest,
  type ImportJobDto,
  type ImportJobPageDto,
  type ImportRequest,
  type ImportResultDto,
  type ImportRowErrorDto,
  type PageQuery,
  type UpdateItemDraftRequest,
} from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService, type Prisma, type Tx } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";
import { CatalogService } from "./catalog.service.js";
import { CsvError, parseCsv } from "./csv.js";

const FIXED_COLUMNS = new Set(["sku", "kind", "name", "description", "unit", "category"]);
const REQUIRED_COLUMNS = ["sku", "kind", "name"] as const;
const FEATURE_PREFIX = "feature:";
const IMPORT_TX_TIMEOUT_MS = 120_000;

type Feature = { name: string; value: string };
type Content = { name: string; description: string | null; unit: string | null; categoryId: string | null; features: Feature[] };
type Action = "create" | "update" | "unchanged";
type Plan = {
  row: number;
  sku: string;
  skuKey: string;
  action: Action;
  create?: CreateItemRequest;
  itemId?: string;
  hasDraft?: boolean;
  patch?: UpdateItemDraftRequest;
};
type Layout = { index: Map<string, number>; featureColumns: Array<{ name: string; index: number }>; managed: Set<string> };

const badFile = (code: string, extra: Record<string, unknown> = {}) =>
  new ApiException(400, "VALIDATION_FAILED", "Validation failed", { issues: [{ path: "csv", code, ...extra }] });

const sortFeatures = (f: Feature[]) => [...f].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
const sameFeatures = (a: Feature[], b: Feature[]) => JSON.stringify(sortFeatures(a)) === JSON.stringify(sortFeatures(b));

@Injectable()
export class ImportService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
  ) {}

  /**
   * dry_run: full validation and diff against the catalog, nothing changes.
   * apply: same analysis; if there is ANY row error nothing is written (status "rejected"), otherwise every change is applied in ONE transaction.
   * Imports only ever create/update DRAFTS - approval stays a separate catalog:approve action. Re-importing the same file is a no-op ("unchanged").
   */
  async run(auth: AuthContext, input: ImportRequest): Promise<ImportResultDto> {
    const records = this.parse(input.csv);
    const layout = this.layout(records[0] as string[]);
    const fileHash = createHash("sha256").update(input.csv, "utf8").digest("hex");

    try {
      return await this.db.withTenant(
        auth,
        async (tx) => {
          const analysis = await this.analyze(tx, auth, records.slice(1), layout);
          const counts = { created: 0, updated: 0, unchanged: 0 };
          for (const p of analysis.plans) counts[p.action === "create" ? "created" : p.action === "update" ? "updated" : "unchanged"]++;
          const hasErrors = analysis.errors.length > 0;

          let status: ImportJobDto["status"];
          let shown = counts;
          if (input.mode === "dry_run") {
            status = hasErrors ? "invalid" : "valid";
          } else if (hasErrors) {
            status = "rejected";
            shown = { created: 0, updated: 0, unchanged: 0 };
          } else {
            await this.applyPlans(tx, auth, analysis.plans);
            status = "applied";
          }

          const reported = analysis.errors.slice(0, IMPORT_LIMITS.maxReportedErrors);
          const job = await tx.importJob.create({
            data: {
              organization_id: auth.organizationId, kind: "catalog_items", mode: input.mode, status, file_hash: fileHash, total_rows: records.length - 1,
              created_count: shown.created, updated_count: shown.updated, unchanged_count: shown.unchanged, error_count: analysis.errors.length,
              errors: reported as unknown as Prisma.InputJsonValue, created_by: auth.userId,
            },
          });
          if (input.mode === "apply") {
            await this.audit.record(tx, auth, {
              action: status === "applied" ? "catalog.import_applied" : "catalog.import_rejected",
              resourceType: "import_job",
              resourceId: job.id,
              metadata: { ...shown, errors: analysis.errors.length, fileHash },
            });
          }
          return {
            ...this.toDto(job),
            rows: [
              ...analysis.plans.map((p) => ({ row: p.row, sku: p.sku, action: p.action })),
              ...analysis.errorRows.map((r) => ({ row: r.row, sku: r.sku, action: "error" as const })),
            ].sort((a, b) => a.row - b.row),
          };
        },
        { timeoutMs: IMPORT_TX_TIMEOUT_MS },
      );
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") {
        throw new ApiException(409, "CONFLICT", "The catalog changed while importing; nothing was applied. Retry the import.");
      }
      throw e;
    }
  }

  listJobs(auth: AuthContext, q: PageQuery): Promise<ImportJobPageDto> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.importJob.findMany({
        where: { organization_id: auth.organizationId, kind: "catalog_items", ...(q.cursor ? { id: { gt: q.cursor } } : {}) },
        orderBy: { id: "asc" },
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      return { items: page.map((j) => this.toDto(j)), nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
    });
  }

  getJob(auth: AuthContext, id: string): Promise<ImportJobDto> {
    return this.db.withTenant(auth, async (tx) => {
      const job = await tx.importJob.findFirst({ where: { id, organization_id: auth.organizationId, kind: "catalog_items" } });
      if (!job) throw new NotFoundException();
      return this.toDto(job);
    });
  }

  /* ---------- parsing ---------- */

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

  private layout(header: string[]): Layout {
    const index = new Map<string, number>();
    const featureColumns: Layout["featureColumns"] = [];
    const seen = new Set<string>();
    header.forEach((raw, i) => {
      const name = raw.trim();
      const lower = name.toLowerCase();
      if (seen.has(lower)) throw badFile("duplicate_column", { column: name });
      seen.add(lower);
      if (lower.startsWith(FEATURE_PREFIX)) {
        const featureName = name.slice(FEATURE_PREFIX.length).trim();
        if (!featureName || featureName.length > 60) throw badFile("invalid_column", { column: name.slice(0, 80) });
        featureColumns.push({ name: featureName, index: i });
      } else if (FIXED_COLUMNS.has(lower)) {
        index.set(lower, i);
      } else {
        throw badFile("unknown_column", { column: name.slice(0, 80) });
      }
    });
    for (const required of REQUIRED_COLUMNS) if (!index.has(required)) throw badFile("missing_column", { column: required });
    const managed = new Set<string>(["name"]);
    for (const c of ["description", "unit", "category"]) if (index.has(c)) managed.add(c);
    if (featureColumns.length) managed.add("features");
    return { index, featureColumns, managed };
  }

  /* ---------- analysis (read-only) ---------- */

  private async analyze(tx: Tx, auth: AuthContext, rows: string[][], layout: Layout) {
    const errors: ImportRowErrorDto[] = [];
    const errorRows: Array<{ row: number; sku: string | null }> = [];
    const parsed: Array<{ row: number; data: ImportRow }> = [];
    const firstRowOfSku = new Map<string, number>();
    const headerWidth = layout.index.size + layout.featureColumns.length;

    rows.forEach((cells, i) => {
      const row = i + 2; // header is row 1
      const cell = (name: string) => {
        const at = layout.index.get(name);
        const v = at === undefined ? undefined : cells[at]?.trim();
        return v ? v : undefined;
      };
      const sku = cell("sku") ?? null;
      const fail = (code: string, message: string, column: string | null = null) => {
        errors.push({ row, sku, column, code, message });
        if (!errorRows.some((r) => r.row === row)) errorRows.push({ row, sku });
      };
      if (cells.length !== headerWidth) return fail("column_count", `Expected ${headerWidth} columns but found ${cells.length}`);

      const features: Feature[] = [];
      for (const f of layout.featureColumns) {
        const value = cells[f.index]?.trim();
        if (value) features.push({ name: f.name, value });
      }
      const candidate = {
        kind: cell("kind")?.toLowerCase(), sku: cell("sku"), name: cell("name"), description: cell("description"), unit: cell("unit"), category: cell("category"),
        ...(layout.featureColumns.length ? { features } : {}),
      };
      const result = ImportRow.safeParse(candidate);
      if (!result.success) {
        for (const issue of result.error.issues) fail(issue.code, issue.message, String(issue.path[0] ?? "") || null);
        return;
      }
      const key = result.data.sku.toLowerCase();
      const earlier = firstRowOfSku.get(key);
      if (earlier !== undefined) return fail("duplicate_in_file", `SKU already appears in row ${earlier}`, "sku");
      firstRowOfSku.set(key, row);
      parsed.push({ row, data: result.data });
    });

    const names = [...new Set(parsed.flatMap((p) => (p.data.category ? [p.data.category.normalize("NFKC").toLowerCase()] : [])))];
    const categories = names.length
      ? await tx.catalogCategory.findMany({ where: { organization_id: auth.organizationId, status: "active", name_key: { in: names } }, select: { id: true, name_key: true } })
      : [];
    const categoryByKey = new Map(categories.map((c) => [c.name_key, c.id]));

    const existing = parsed.length
      ? await tx.catalogItem.findMany({ where: { organization_id: auth.organizationId, sku_key: { in: [...firstRowOfSku.keys()] } } })
      : [];
    const bySku = new Map(existing.map((i) => [i.sku_key, i]));
    const latest = existing.length
      ? await tx.catalogItemVersion.findMany({
          where: { organization_id: auth.organizationId, OR: existing.map((i) => ({ item_id: i.id, version: i.latest_version })) },
        })
      : [];
    const latestByItem = new Map(latest.map((v) => [v.item_id, v]));

    const plans: Plan[] = [];
    for (const { row, data } of parsed) {
      const skuKey = data.sku.toLowerCase();
      const fail = (code: string, message: string, column: string | null = null) => {
        errors.push({ row, sku: data.sku, column, code, message });
        errorRows.push({ row, sku: data.sku });
      };
      let categoryId: string | null = null;
      if (data.category) {
        categoryId = categoryByKey.get(data.category.normalize("NFKC").toLowerCase()) ?? null;
        if (!categoryId) {
          fail("unknown_category", "Category does not exist or is disabled (categories are never created by an import)", "category");
          continue;
        }
      }
      const item = bySku.get(skuKey);
      if (!item) {
        plans.push({
          row, sku: data.sku, skuKey, action: "create",
          create: { kind: data.kind, sku: data.sku, name: data.name, description: data.description ?? null, unit: data.unit ?? null, categoryId, features: data.features ?? [] },
        });
        continue;
      }
      if (item.kind !== data.kind) {
        fail("kind_mismatch", `The existing item is a ${item.kind}; the kind of an item cannot change`, "kind");
        continue;
      }
      if (item.archived_at) {
        fail("item_archived", "The item is archived; restore it before importing changes", "sku");
        continue;
      }
      const current = latestByItem.get(item.id);
      if (!current) {
        fail("item_inconsistent", "The item has no readable latest version");
        continue;
      }
      const wanted: Content = {
        name: data.name,
        description: layout.managed.has("description") ? (data.description ?? null) : current.description,
        unit: layout.managed.has("unit") ? (data.unit ?? null) : current.unit,
        categoryId: layout.managed.has("category") ? categoryId : current.category_id,
        features: layout.managed.has("features") ? (data.features ?? []) : (current.features as Feature[]),
      };
      const same =
        wanted.name === current.name && wanted.description === current.description && wanted.unit === current.unit &&
        wanted.categoryId === current.category_id && sameFeatures(wanted.features, current.features as Feature[]);
      if (same) {
        plans.push({ row, sku: data.sku, skuKey, action: "unchanged", itemId: item.id });
        continue;
      }
      plans.push({
        row, sku: data.sku, skuKey, action: "update", itemId: item.id, hasDraft: current.state === "draft",
        patch: { name: wanted.name, description: wanted.description, unit: wanted.unit, categoryId: wanted.categoryId, features: wanted.features },
      });
    }
    errors.sort((a, b) => a.row - b.row);
    return { plans, errors, errorRows };
  }

  /** Deterministic order (by SKU) so concurrent imports lock items in the same sequence. Any failure aborts the whole transaction. */
  private async applyPlans(tx: Tx, auth: AuthContext, plans: Plan[]): Promise<void> {
    for (const plan of [...plans].sort((a, b) => a.skuKey.localeCompare(b.skuKey))) {
      if (plan.action === "create" && plan.create) {
        await this.catalog.createItemTx(tx, auth, plan.create);
      } else if (plan.action === "update" && plan.itemId && plan.patch) {
        if (!plan.hasDraft) await this.catalog.createDraftTx(tx, auth, plan.itemId);
        await this.catalog.updateDraftTx(tx, auth, plan.itemId, plan.patch);
      }
    }
  }

  private toDto(j: {
    id: string; mode: string; status: string; file_hash: string; total_rows: number; created_count: number; updated_count: number;
    unchanged_count: number; error_count: number; errors: Prisma.JsonValue; created_by: string; created_at: Date;
  }): ImportJobDto {
    const errors = j.errors as unknown as ImportRowErrorDto[];
    return {
      id: j.id, mode: j.mode as ImportJobDto["mode"], status: j.status as ImportJobDto["status"], fileHash: j.file_hash,
      totals: { rows: j.total_rows, created: j.created_count, updated: j.updated_count, unchanged: j.unchanged_count, errors: j.error_count },
      errors, errorsTruncated: j.error_count > errors.length, createdBy: j.created_by, createdAt: j.created_at.toISOString(),
    };
  }
}

import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  CategoryDto,
  CreateCategoryRequest,
  CreateItemRequest,
  ItemDto,
  ItemListQuery,
  ItemPageDto,
  ItemVersionDto,
  UpdateCategoryRequest,
  UpdateItemDraftRequest,
} from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService, type Prisma, type Tx } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";

const UNIQUE_VIOLATION = "P2002";
const isUnique = (e: unknown) => (e as { code?: string }).code === UNIQUE_VIOLATION;
const nameKey = (name: string) => name.normalize("NFKC").toLowerCase();
const conflict = (message: string) => new ApiException(409, "CONFLICT", message);

type VersionRow = {
  id: string; version: number; state: ItemVersionDto["state"]; name: string; description: string | null; unit: string | null;
  features: Prisma.JsonValue; category_id: string | null; created_by: string; approved_by: string | null; approved_at: Date | null; created_at: Date;
};
const versionDto = (r: VersionRow): ItemVersionDto => ({
  id: r.id, version: r.version, state: r.state, name: r.name, description: r.description, unit: r.unit,
  categoryId: r.category_id, features: r.features as ItemVersionDto["features"], createdBy: r.created_by,
  approvedBy: r.approved_by, approvedAt: r.approved_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(),
});

type ItemRow = {
  id: string; kind: ItemDto["kind"]; sku: string; latest_version: number; approved_version: number | null; archived_at: Date | null;
  created_at: Date; updated_at: Date;
};
const itemStatus = (i: ItemRow): ItemDto["status"] => (i.archived_at ? "archived" : i.approved_version !== null ? "approved" : "draft");
const itemDto = (i: ItemRow, versions: VersionRow[]): ItemDto => {
  const approved = i.approved_version !== null && !i.archived_at ? versions.find((v) => v.version === i.approved_version && v.state === "approved") : undefined;
  const draft = versions.find((v) => v.state === "draft");
  return {
    id: i.id, kind: i.kind, sku: i.sku, status: itemStatus(i), latestVersion: i.latest_version, approvedVersion: i.approved_version,
    archivedAt: i.archived_at?.toISOString() ?? null, approved: approved ? versionDto(approved) : null, draft: draft ? versionDto(draft) : null,
    createdAt: i.created_at.toISOString(), updatedAt: i.updated_at.toISOString(),
  };
};

type CategoryRow = { id: string; name: string; status: "active" | "disabled" };
const categorySelect = { id: true, name: true, status: true } as const;

@Injectable()
export class CatalogService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /* ---------- categories ---------- */

  listCategories(auth: AuthContext): Promise<CategoryDto[]> {
    return this.db.withTenant(auth, (tx) =>
      tx.catalogCategory.findMany({ where: { organization_id: auth.organizationId }, select: categorySelect, orderBy: [{ name_key: "asc" }, { id: "asc" }] }),
    );
  }

  async createCategory(auth: AuthContext, input: CreateCategoryRequest): Promise<CategoryDto> {
    try {
      return await this.db.withTenant(auth, async (tx) => {
        const row: CategoryRow = await tx.catalogCategory.create({
          data: { organization_id: auth.organizationId, name: input.name, name_key: nameKey(input.name) },
          select: categorySelect,
        });
        await this.audit.record(tx, auth, { action: "catalog.category_created", resourceType: "catalog_category", resourceId: row.id });
        return row;
      });
    } catch (e) {
      throw isUnique(e) ? conflict("A category with that name already exists") : e;
    }
  }

  async updateCategory(auth: AuthContext, id: string, input: UpdateCategoryRequest): Promise<CategoryDto> {
    try {
      return await this.db.withTenant(auth, async (tx) => {
        const current = await tx.catalogCategory.findFirst({ where: { id, organization_id: auth.organizationId }, select: { id: true } });
        if (!current) throw new NotFoundException();
        const row: CategoryRow = await tx.catalogCategory.update({
          where: { id },
          data: { ...(input.name !== undefined ? { name: input.name, name_key: nameKey(input.name) } : {}), ...(input.status !== undefined ? { status: input.status } : {}) },
          select: categorySelect,
        });
        await this.audit.record(tx, auth, { action: "catalog.category_updated", resourceType: "catalog_category", resourceId: id, metadata: { changedFields: Object.keys(input) } });
        return row;
      });
    } catch (e) {
      throw isUnique(e) ? conflict("A category with that name already exists") : e;
    }
  }

  /* ---------- items ---------- */

  async listItems(auth: AuthContext, q: ItemListQuery): Promise<ItemPageDto> {
    return this.db.withTenant(auth, async (tx) => {
      const status: Prisma.CatalogItemWhereInput =
        q.status === "archived" ? { archived_at: { not: null } }
        : q.status === "approved" ? { archived_at: null, approved_version: { not: null } }
        : q.status === "draft" ? { archived_at: null, approved_version: null }
        : {};
      const rows = await tx.catalogItem.findMany({
        where: {
          organization_id: auth.organizationId,
          ...status,
          ...(q.kind ? { kind: q.kind } : {}),
          ...(q.categoryId ? { versions: { some: { category_id: q.categoryId, state: { in: ["draft", "approved"] } } } } : {}),
          ...(q.cursor ? { sku_key: { gt: q.cursor } } : {}),
        },
        orderBy: { sku_key: "asc" },
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const versions = page.length
        ? await tx.catalogItemVersion.findMany({ where: { organization_id: auth.organizationId, item_id: { in: page.map((r) => r.id) }, state: { in: ["draft", "approved"] } } })
        : [];
      return {
        items: page.map((i) => itemDto(i, versions.filter((v) => v.item_id === i.id))),
        nextCursor: rows.length > q.limit ? (page[page.length - 1]?.sku_key ?? null) : null,
      };
    });
  }

  getItem(auth: AuthContext, id: string): Promise<ItemDto> {
    return this.db.withTenant(auth, (tx) => this.load(tx, auth, id));
  }

  listVersions(auth: AuthContext, id: string): Promise<ItemVersionDto[]> {
    return this.db.withTenant(auth, async (tx) => {
      await this.load(tx, auth, id); // 404 for unknown / other tenant
      const rows = await tx.catalogItemVersion.findMany({ where: { organization_id: auth.organizationId, item_id: id }, orderBy: { version: "desc" } });
      return rows.map(versionDto);
    });
  }

  async createItem(auth: AuthContext, input: CreateItemRequest): Promise<ItemDto> {
    try {
      return await this.db.withTenant(auth, async (tx) => {
        await this.assertCategory(tx, auth, input.categoryId);
        const item = await tx.catalogItem.create({
          data: { organization_id: auth.organizationId, kind: input.kind, sku: input.sku, sku_key: input.sku.toLowerCase(), created_by: auth.userId },
        });
        await tx.catalogItemVersion.create({
          data: {
            organization_id: auth.organizationId, item_id: item.id, version: 1, state: "draft", name: input.name, description: input.description ?? null,
            unit: input.unit ?? null, category_id: input.categoryId ?? null, features: (input.features ?? []) as Prisma.InputJsonValue, created_by: auth.userId,
          },
        });
        await this.audit.record(tx, auth, { action: "catalog.item_created", resourceType: "catalog_item", resourceId: item.id, metadata: { kind: input.kind } });
        return this.load(tx, auth, item.id);
      });
    } catch (e) {
      throw isUnique(e) ? conflict("An item with that SKU already exists") : e;
    }
  }

  updateDraft(auth: AuthContext, id: string, input: UpdateItemDraftRequest): Promise<ItemDto> {
    return this.db.withTenant(auth, async (tx) => {
      const item = await this.lock(tx, auth, id);
      this.assertNotArchived(item);
      const draft = await this.openDraft(tx, auth, id);
      if (!draft) throw conflict("There is no open draft; start a new version first");
      await this.assertCategory(tx, auth, input.categoryId);
      await tx.catalogItemVersion.update({
        where: { id: draft.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.unit !== undefined ? { unit: input.unit } : {}),
          ...(input.categoryId !== undefined ? { category_id: input.categoryId } : {}),
          ...(input.features !== undefined ? { features: input.features as Prisma.InputJsonValue } : {}),
        },
      });
      await this.audit.record(tx, auth, {
        action: "catalog.item_draft_updated", resourceType: "catalog_item", resourceId: id, metadata: { version: draft.version, changedFields: Object.keys(input) },
      });
      return this.load(tx, auth, id);
    });
  }

  createDraft(auth: AuthContext, id: string): Promise<ItemDto> {
    return this.db.withTenant(auth, async (tx) => {
      const item = await this.lock(tx, auth, id);
      this.assertNotArchived(item);
      if (await this.openDraft(tx, auth, id)) throw conflict("This item already has an open draft");
      const source = await tx.catalogItemVersion.findFirst({ where: { organization_id: auth.organizationId, item_id: id, version: item.latest_version } });
      if (!source) throw new NotFoundException();
      const next = item.latest_version + 1;
      await tx.catalogItemVersion.create({
        data: {
          organization_id: auth.organizationId, item_id: id, version: next, state: "draft", name: source.name, description: source.description, unit: source.unit,
          category_id: source.category_id, features: source.features as Prisma.InputJsonValue, created_by: auth.userId,
        },
      });
      await tx.catalogItem.update({ where: { id }, data: { latest_version: next } });
      await this.audit.record(tx, auth, { action: "catalog.item_version_created", resourceType: "catalog_item", resourceId: id, metadata: { version: next, basedOn: source.version } });
      return this.load(tx, auth, id);
    });
  }

  approve(auth: AuthContext, id: string): Promise<ItemDto> {
    return this.db.withTenant(auth, async (tx) => {
      const item = await this.lock(tx, auth, id);
      this.assertNotArchived(item);
      const draft = await this.openDraft(tx, auth, id);
      if (!draft) throw conflict("There is no open draft to approve");
      if (item.approved_version !== null) {
        await tx.catalogItemVersion.updateMany({ where: { organization_id: auth.organizationId, item_id: id, version: item.approved_version, state: "approved" }, data: { state: "superseded" } });
      }
      await tx.catalogItemVersion.update({ where: { id: draft.id }, data: { state: "approved", approved_by: auth.userId, approved_at: new Date() } });
      await tx.catalogItem.update({ where: { id }, data: { approved_version: draft.version } });
      await this.audit.record(tx, auth, {
        action: "catalog.item_approved", resourceType: "catalog_item", resourceId: id, metadata: { version: draft.version, supersedes: item.approved_version },
      });
      return this.load(tx, auth, id);
    });
  }

  archive(auth: AuthContext, id: string): Promise<ItemDto> {
    return this.db.withTenant(auth, async (tx) => {
      const item = await this.lock(tx, auth, id);
      this.assertNotArchived(item);
      await tx.catalogItem.update({ where: { id }, data: { archived_at: new Date() } });
      await this.audit.record(tx, auth, { action: "catalog.item_archived", resourceType: "catalog_item", resourceId: id });
      return this.load(tx, auth, id);
    });
  }

  restore(auth: AuthContext, id: string): Promise<ItemDto> {
    return this.db.withTenant(auth, async (tx) => {
      const item = await this.lock(tx, auth, id);
      if (!item.archived_at) throw conflict("The item is not archived");
      await tx.catalogItem.update({ where: { id }, data: { archived_at: null } });
      await this.audit.record(tx, auth, { action: "catalog.item_restored", resourceType: "catalog_item", resourceId: id });
      return this.load(tx, auth, id);
    });
  }

  /* ---------- helpers ---------- */

  private async load(tx: Tx, auth: AuthContext, id: string): Promise<ItemDto> {
    const item = await tx.catalogItem.findFirst({ where: { id, organization_id: auth.organizationId } });
    if (!item) throw new NotFoundException();
    const versions = await tx.catalogItemVersion.findMany({ where: { organization_id: auth.organizationId, item_id: id, state: { in: ["draft", "approved"] } } });
    return itemDto(item, versions);
  }

  /** Row lock serializes concurrent edits/approvals of one item; absent or foreign ids are a plain 404. */
  private async lock(tx: Tx, auth: AuthContext, id: string): Promise<ItemRow> {
    const rows = await tx.$queryRaw<ItemRow[]>`SELECT id, kind, sku, latest_version, approved_version, archived_at, created_at, updated_at
      FROM catalog_items WHERE id = ${id}::uuid AND organization_id = ${auth.organizationId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }

  private openDraft(tx: Tx, auth: AuthContext, itemId: string) {
    return tx.catalogItemVersion.findFirst({ where: { organization_id: auth.organizationId, item_id: itemId, state: "draft" } });
  }

  private assertNotArchived(item: ItemRow): void {
    if (item.archived_at) throw conflict("The item is archived; restore it first");
  }

  private async assertCategory(tx: Tx, auth: AuthContext, categoryId: string | null | undefined): Promise<void> {
    if (!categoryId) return;
    const found = await tx.catalogCategory.findFirst({ where: { id: categoryId, organization_id: auth.organizationId, status: "active" }, select: { id: true } });
    if (!found) throw new ApiException(400, "VALIDATION_FAILED", "Validation failed", { issues: [{ path: "categoryId", code: "invalid_reference" }] });
  }
}

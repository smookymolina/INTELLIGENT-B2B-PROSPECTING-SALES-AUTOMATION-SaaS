import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  ApprovedPricePageDto,
  ClonePriceListRequest,
  CreatePriceListRequest,
  PageQuery,
  PriceEntryDto,
  PriceEntryPageDto,
  PriceListDto,
  PriceListPageDto,
  PriceListQuery,
  SetPriceRequest,
  UpdatePriceListRequest,
} from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService, type Tx } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";

const isUnique = (e: unknown) => (e as { code?: string }).code === "P2002";
const conflict = (message: string, details: unknown = null) => new ApiException(409, "CONFLICT", message, details);
const nameKey = (name: string) => name.normalize("NFKC").toLowerCase();
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const asDate = (v: string | null | undefined) => (v ? new Date(`${v}T00:00:00.000Z`) : v === null ? null : undefined);
const money = (d: { toFixed(n: number): string }) => d.toFixed(4);

type ListRow = {
  id: string; name: string; currency: string; status: PriceListDto["status"]; valid_from: Date | null; valid_until: Date | null;
  cloned_from: string | null; approved_by: string | null; approved_at: Date | null; archived_at: Date | null; created_at: Date;
};
const listDto = (r: ListRow, entryCount: number): PriceListDto => ({
  id: r.id, name: r.name, currency: r.currency, status: r.status, validFrom: day(r.valid_from), validUntil: day(r.valid_until), clonedFrom: r.cloned_from,
  entryCount, createdAt: r.created_at.toISOString(), approvedAt: r.approved_at?.toISOString() ?? null, approvedBy: r.approved_by, archivedAt: r.archived_at?.toISOString() ?? null,
});

@Injectable()
export class PricingService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /* ---------- lists ---------- */

  listLists(auth: AuthContext, q: PriceListQuery): Promise<PriceListPageDto> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.priceList.findMany({
        where: { organization_id: auth.organizationId, ...(q.status !== "all" ? { status: q.status } : {}), ...(q.cursor ? { id: { gt: q.cursor } } : {}) },
        orderBy: { id: "asc" },
        take: q.limit + 1,
        include: { _count: { select: { entries: true } } },
      });
      const page = rows.slice(0, q.limit);
      return { items: page.map((r) => listDto(r, r._count.entries)), nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
    });
  }

  getList(auth: AuthContext, id: string): Promise<PriceListDto> {
    return this.db.withTenant(auth, (tx) => this.load(tx, auth, id));
  }

  async createList(auth: AuthContext, input: CreatePriceListRequest): Promise<PriceListDto> {
    try {
      return await this.db.withTenant(auth, async (tx) => {
        const row = await tx.priceList.create({
          data: {
            organization_id: auth.organizationId, name: input.name, name_key: nameKey(input.name), currency: input.currency,
            valid_from: asDate(input.validFrom) ?? null, valid_until: asDate(input.validUntil) ?? null, created_by: auth.userId,
          },
        });
        await this.audit.record(tx, auth, { action: "pricing.list_created", resourceType: "price_list", resourceId: row.id, metadata: { currency: row.currency } });
        return listDto(row, 0);
      });
    } catch (e) {
      throw isUnique(e) ? conflict("A price list with that name already exists") : e;
    }
  }

  async updateList(auth: AuthContext, id: string, input: UpdatePriceListRequest): Promise<PriceListDto> {
    try {
      return await this.db.withTenant(auth, async (tx) => {
        const list = await this.lock(tx, auth, id);
        this.assertDraft(list);
        const from = input.validFrom !== undefined ? asDate(input.validFrom) ?? null : list.valid_from;
        const until = input.validUntil !== undefined ? asDate(input.validUntil) ?? null : list.valid_until;
        if (from && until && until < from) {
          throw new ApiException(400, "VALIDATION_FAILED", "Validation failed", { issues: [{ path: "validUntil", code: "custom" }] });
        }
        await tx.priceList.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name, name_key: nameKey(input.name) } : {}),
            ...(input.validFrom !== undefined ? { valid_from: from } : {}),
            ...(input.validUntil !== undefined ? { valid_until: until } : {}),
          },
        });
        await this.audit.record(tx, auth, { action: "pricing.list_updated", resourceType: "price_list", resourceId: id, metadata: { changedFields: Object.keys(input) } });
        return this.load(tx, auth, id);
      });
    } catch (e) {
      throw isUnique(e) ? conflict("A price list with that name already exists") : e;
    }
  }

  async clone(auth: AuthContext, id: string, input: ClonePriceListRequest): Promise<PriceListDto> {
    try {
      return await this.db.withTenant(auth, async (tx) => {
        const source = await this.lock(tx, auth, id);
        const copy = await tx.priceList.create({
          data: {
            organization_id: auth.organizationId, name: input.name, name_key: nameKey(input.name), currency: source.currency,
            valid_from: source.valid_from, valid_until: source.valid_until, cloned_from: id, created_by: auth.userId,
          },
        });
        const entries = await tx.priceListEntry.findMany({ where: { organization_id: auth.organizationId, price_list_id: id }, select: { item_id: true, unit_price: true } });
        if (entries.length) {
          await tx.priceListEntry.createMany({
            data: entries.map((e) => ({ organization_id: auth.organizationId, price_list_id: copy.id, item_id: e.item_id, unit_price: e.unit_price, created_by: auth.userId })),
          });
        }
        await this.audit.record(tx, auth, { action: "pricing.list_cloned", resourceType: "price_list", resourceId: copy.id, metadata: { clonedFrom: id, entries: entries.length } });
        return listDto(copy, entries.length);
      });
    } catch (e) {
      throw isUnique(e) ? conflict("A price list with that name already exists") : e;
    }
  }

  approve(auth: AuthContext, id: string): Promise<PriceListDto> {
    return this.db.withTenant(auth, async (tx) => {
      const list = await this.lock(tx, auth, id);
      this.assertDraft(list);
      const total = await tx.priceListEntry.count({ where: { organization_id: auth.organizationId, price_list_id: id } });
      if (total === 0) throw conflict("A price list needs at least one price to be approved");
      const unapproved = await tx.priceListEntry.findMany({
        where: { organization_id: auth.organizationId, price_list_id: id, item: { OR: [{ approved_version: null }, { archived_at: { not: null } }] } },
        select: { item: { select: { sku: true } } },
        orderBy: { item: { sku_key: "asc" } },
        take: 20,
      });
      if (unapproved.length) {
        throw conflict("Every priced item must be approved and not archived", { skus: unapproved.map((e) => e.item.sku) });
      }
      await tx.priceList.update({ where: { id }, data: { status: "approved", approved_by: auth.userId, approved_at: new Date() } });
      await this.audit.record(tx, auth, { action: "pricing.list_approved", resourceType: "price_list", resourceId: id, metadata: { entries: total } });
      return this.load(tx, auth, id);
    });
  }

  archive(auth: AuthContext, id: string): Promise<PriceListDto> {
    return this.db.withTenant(auth, async (tx) => {
      const list = await this.lock(tx, auth, id);
      if (list.status === "archived") throw conflict("The price list is already archived");
      await tx.priceList.update({ where: { id }, data: { status: "archived", archived_at: new Date() } });
      await this.audit.record(tx, auth, { action: "pricing.list_archived", resourceType: "price_list", resourceId: id, metadata: { from: list.status } });
      return this.load(tx, auth, id);
    });
  }

  /* ---------- entries ---------- */

  listEntries(auth: AuthContext, id: string, q: PageQuery): Promise<PriceEntryPageDto> {
    return this.db.withTenant(auth, async (tx) => {
      await this.load(tx, auth, id);
      const rows = await tx.priceListEntry.findMany({
        where: { organization_id: auth.organizationId, price_list_id: id, ...(q.cursor ? { id: { gt: q.cursor } } : {}) },
        orderBy: { id: "asc" },
        take: q.limit + 1,
        include: { item: { select: { sku: true } } },
      });
      const page = rows.slice(0, q.limit);
      return {
        items: page.map((e) => ({ id: e.id, itemId: e.item_id, sku: e.item.sku, unitPrice: money(e.unit_price) })),
        nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    });
  }

  setPrice(auth: AuthContext, id: string, itemId: string, input: SetPriceRequest): Promise<PriceEntryDto> {
    return this.db.withTenant(auth, async (tx) => {
      const list = await this.lock(tx, auth, id);
      this.assertDraft(list);
      const item = await tx.catalogItem.findFirst({ where: { id: itemId, organization_id: auth.organizationId }, select: { id: true, sku: true, archived_at: true } });
      if (!item) throw new NotFoundException();
      if (item.archived_at) throw conflict("Archived items cannot be priced");
      const existing = await tx.priceListEntry.findFirst({ where: { organization_id: auth.organizationId, price_list_id: id, item_id: itemId }, select: { id: true } });
      const row = existing
        ? await tx.priceListEntry.update({ where: { id: existing.id }, data: { unit_price: input.unitPrice } })
        : await tx.priceListEntry.create({ data: { organization_id: auth.organizationId, price_list_id: id, item_id: itemId, unit_price: input.unitPrice, created_by: auth.userId } });
      // Audit records which item was priced, never the amount (commercial data).
      await this.audit.record(tx, auth, { action: existing ? "pricing.price_updated" : "pricing.price_set", resourceType: "price_list", resourceId: id, metadata: { itemId } });
      return { id: row.id, itemId, sku: item.sku, unitPrice: money(row.unit_price) };
    });
  }

  removePrice(auth: AuthContext, id: string, itemId: string): Promise<void> {
    return this.db.withTenant(auth, async (tx) => {
      const list = await this.lock(tx, auth, id);
      this.assertDraft(list);
      const removed = await tx.priceListEntry.deleteMany({ where: { organization_id: auth.organizationId, price_list_id: id, item_id: itemId } });
      if (removed.count === 0) throw new NotFoundException();
      await this.audit.record(tx, auth, { action: "pricing.price_removed", resourceType: "price_list", resourceId: id, metadata: { itemId } });
    });
  }

  /**
   * Single source of consumable prices (quotes, AI): the list must be approved AND each item must be approved and not archived NOW.
   * Item name/version come from the item's current approved version, so a price never travels with unapproved content.
   */
  listApprovedPrices(auth: AuthContext, id: string, q: PageQuery): Promise<ApprovedPricePageDto> {
    return this.db.withTenant(auth, async (tx) => {
      const list = await this.load(tx, auth, id);
      if (list.status !== "approved") throw conflict("The price list is not approved");
      const rows = await tx.priceListEntry.findMany({
        where: {
          organization_id: auth.organizationId, price_list_id: id, item: { approved_version: { not: null }, archived_at: null },
          ...(q.cursor ? { id: { gt: q.cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: q.limit + 1,
        include: { item: { select: { sku: true, kind: true, approved_version: true } } },
      });
      const page = rows.slice(0, q.limit);
      const versions = page.length
        ? await tx.catalogItemVersion.findMany({
            where: { organization_id: auth.organizationId, state: "approved", item_id: { in: page.map((r) => r.item_id) } },
            select: { item_id: true, version: true, name: true },
          })
        : [];
      const items = page.flatMap((e) => {
        const v = versions.find((x) => x.item_id === e.item_id && x.version === e.item.approved_version);
        return v
          ? [{
              priceListId: id, entryId: e.id, itemId: e.item_id, sku: e.item.sku, kind: e.item.kind, itemVersion: v.version, itemName: v.name,
              unitPrice: money(e.unit_price), currency: list.currency, validFrom: list.validFrom, validUntil: list.validUntil,
            }]
          : [];
      });
      return { items, nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
    });
  }

  /* ---------- helpers ---------- */

  private async load(tx: Tx, auth: AuthContext, id: string): Promise<PriceListDto> {
    const row = await tx.priceList.findFirst({ where: { id, organization_id: auth.organizationId }, include: { _count: { select: { entries: true } } } });
    if (!row) throw new NotFoundException();
    return listDto(row, row._count.entries);
  }

  /** Row lock: serializes edits, approvals and clones of one list; foreign or unknown ids are a plain 404. */
  private async lock(tx: Tx, auth: AuthContext, id: string): Promise<ListRow> {
    const rows = await tx.$queryRaw<ListRow[]>`SELECT id, name, currency, status, valid_from, valid_until, cloned_from, approved_by, approved_at, archived_at, created_at
      FROM price_lists WHERE id = ${id}::uuid AND organization_id = ${auth.organizationId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }

  private assertDraft(list: ListRow): void {
    if (list.status !== "draft") throw conflict("Only draft price lists can be edited; clone it to make changes");
  }
}

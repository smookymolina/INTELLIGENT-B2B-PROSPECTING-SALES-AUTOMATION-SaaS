import { Inject, Injectable } from "@nestjs/common";
import type {
  EvidenceDto,
  EvidenceQuery,
  EvidenceReason,
  ItemEvidenceDto,
  PriceEvidenceDto,
  ResolvedRefDto,
  ResolveRefsDto,
  ResolveRefsRequest,
} from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService, type Prisma } from "../db/prisma.service.js";

const ITEM_REF = /^item:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):v([1-9][0-9]{0,8})$/;
const PRICE_REF = /^price:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const itemRef = (itemId: string, version: number) => `item:${itemId}:v${version}`;
export const priceRef = (entryId: string) => `price:${entryId}`;

const none = (reason: EvidenceReason) => ({ status: "no_evidence" as const, reason });
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const money = (d: { toFixed(n: number): string }) => d.toFixed(4);

type VersionWithContext = {
  item_id: string; version: number; name: string; description: string | null; unit: string | null; features: Prisma.JsonValue; approved_at: Date | null;
  category: { id: string; name: string } | null;
  item: { sku: string; kind: "product" | "service"; approved_version: number | null; archived_at: Date | null };
};
const itemEvidence = (v: VersionWithContext): ItemEvidenceDto => ({
  status: "evidence", ref: itemRef(v.item_id, v.version), itemId: v.item_id, version: v.version, kind: v.item.kind, sku: v.item.sku, name: v.name,
  description: v.description, unit: v.unit, category: v.category, features: v.features as ItemEvidenceDto["features"], approvedAt: v.approved_at?.toISOString() ?? null,
});
const versionInclude = {
  category: { select: { id: true, name: true } },
  item: { select: { sku: true, kind: true, approved_version: true, archived_at: true } },
} as const;

type EntryWithContext = {
  id: string; item_id: string; price_list_id: string; unit_price: { toFixed(n: number): string };
  price_list: { status: "draft" | "approved" | "archived"; currency: string; valid_from: Date | null; valid_until: Date | null };
};
const priceEvidence = (e: EntryWithContext): PriceEvidenceDto => ({
  status: "evidence", ref: priceRef(e.id), priceListId: e.price_list_id, entryId: e.id, itemId: e.item_id, unitPrice: money(e.unit_price),
  currency: e.price_list.currency, validFrom: day(e.price_list.valid_from), validUntil: day(e.price_list.valid_until),
});

/**
 * The only way other modules (AI, quotes) should read commercial facts. It never returns drafts, unapproved lists or archived items,
 * every fact carries a citable ref, and anything missing is answered with an explicit "no_evidence" + reason (never guessed or defaulted).
 */
@Injectable()
export class EvidenceService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  lookup(auth: AuthContext, q: EvidenceQuery): Promise<EvidenceDto> {
    return this.db.withTenant(auth, async (tx) => {
      const item = await tx.catalogItem.findFirst({ where: { organization_id: auth.organizationId, sku_key: q.sku.toLowerCase() } });
      let itemPart: EvidenceDto["item"];
      if (!item) itemPart = none("item_not_found");
      else if (item.archived_at) itemPart = none("item_archived");
      else if (item.approved_version === null) itemPart = none("item_not_approved");
      else {
        const v = await tx.catalogItemVersion.findFirst({
          where: { organization_id: auth.organizationId, item_id: item.id, version: item.approved_version, state: "approved" },
          include: versionInclude,
        });
        itemPart = v ? itemEvidence(v) : none("item_not_approved");
      }
      if (!q.priceListId) return { sku: q.sku, item: itemPart };

      const list = await tx.priceList.findFirst({ where: { id: q.priceListId, organization_id: auth.organizationId } });
      let pricePart: NonNullable<EvidenceDto["price"]>;
      if (!list) pricePart = none("price_list_not_found");
      else if (list.status === "draft") pricePart = none("price_list_not_approved");
      else if (list.status === "archived") pricePart = none("price_list_archived");
      else if (itemPart.status !== "evidence") pricePart = none("item_not_approved");
      else {
        const entry = await tx.priceListEntry.findFirst({
          where: { organization_id: auth.organizationId, price_list_id: list.id, item_id: itemPart.itemId },
          include: { price_list: { select: { status: true, currency: true, valid_from: true, valid_until: true } } },
        });
        pricePart = entry ? priceEvidence(entry) : none("no_price_for_item");
      }
      return { sku: q.sku, item: itemPart, price: pricePart };
    });
  }

  /** Validates citations (e.g. produced by an AI answer). Malformed or unknown refs are normal answers, so a hallucinated ref can never fail the batch. */
  resolve(auth: AuthContext, input: ResolveRefsRequest): Promise<ResolveRefsDto> {
    return this.db.withTenant(auth, async (tx) => {
      const itemRefs = new Map<string, { itemId: string; version: number }>();
      const priceIds = new Set<string>();
      for (const ref of input.refs) {
        const im = ITEM_REF.exec(ref);
        if (im) itemRefs.set(ref, { itemId: im[1] as string, version: Number(im[2]) });
        const pm = PRICE_REF.exec(ref);
        if (pm) priceIds.add(pm[1] as string);
      }
      const versions = itemRefs.size
        ? await tx.catalogItemVersion.findMany({
            where: { organization_id: auth.organizationId, OR: [...itemRefs.values()].map((r) => ({ item_id: r.itemId, version: r.version })) },
            include: versionInclude,
          })
        : [];
      const entries = priceIds.size
        ? await tx.priceListEntry.findMany({
            where: { organization_id: auth.organizationId, id: { in: [...priceIds] } },
            include: { price_list: { select: { status: true, currency: true, valid_from: true, valid_until: true } }, item: { select: { approved_version: true, archived_at: true } } },
          })
        : [];
      const results = input.refs.map((ref) => this.resolveOne(ref, itemRefs.get(ref), versions, PRICE_REF.exec(ref)?.[1], entries));
      return { results };
    });
  }

  private resolveOne(
    ref: string,
    parsedItem: { itemId: string; version: number } | undefined,
    versions: Array<VersionWithContext & { state: "draft" | "approved" | "superseded" }>,
    priceId: string | undefined,
    entries: Array<EntryWithContext & { item: { approved_version: number | null; archived_at: Date | null } }>,
  ): ResolvedRefDto {
    const missing = (reason: EvidenceReason): ResolvedRefDto => ({ ref, status: "no_evidence", reason });
    if (parsedItem) {
      const v = versions.find((x) => x.item_id === parsedItem.itemId && x.version === parsedItem.version);
      if (!v) return missing("unknown_ref");
      if (v.state === "draft") return missing("not_approved");
      if (v.item.archived_at) return { ref, status: "archived", reason: "item_archived" };
      if (v.state === "superseded") {
        return { ref, status: "superseded", ...(v.item.approved_version !== null ? { currentRef: itemRef(v.item_id, v.item.approved_version) } : {}) };
      }
      return { ref, status: "current", evidence: itemEvidence(v) };
    }
    if (priceId) {
      const e = entries.find((x) => x.id === priceId);
      if (!e) return missing("unknown_ref");
      if (e.price_list.status === "draft") return missing("price_list_not_approved");
      if (e.price_list.status === "archived") return { ref, status: "archived", reason: "price_list_archived" };
      if (e.item.archived_at || e.item.approved_version === null) return missing("item_not_approved");
      return { ref, status: "current", evidence: priceEvidence(e) };
    }
    return missing("malformed_ref");
  }
}


import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AddQuoteLineRequest,
  CreateQuoteRequest,
  PageQuery,
  QuoteDecisionRequest,
  QuoteDetailDto,
  QuoteDto,
  QuoteLineDto,
  QuoteListQuery,
  QuotePageDto,
  QuoteSettingsDto,
  SalePageDto,
  SetQuoteSettingsRequest,
  UpdateQuoteRequest,
} from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { EvidenceService } from "../catalog/evidence.service.js";
import { PrismaService, type Tx } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";
import { discountAmount, fmt2, fmt4, gross, toScaled, totals } from "./money.js";

const conflict = (message: string, details: unknown = null) => new ApiException(409, "CONFLICT", message, details);
const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const asDate = (v: string | null | undefined) => (v ? new Date(`${v}T00:00:00.000Z`) : v === null ? null : undefined);
const dec = (d: { toFixed(n: number): string }, n = 4) => d.toFixed(n);

/** Database rule violations -> stable 409 messages (the trigger text is never exposed). */
const DB_RULES: Array<[string, string]> = [
  ["approved price list", "Quotes need an approved price list"],
  ["currency must match", "The quote currency must match the price list"],
  ["open opportunity", "Quotes need an open opportunity"],
  ["lines can only change", "The quote is not a draft"],
  ["sent quotes are immutable", "The quote has already been sent"],
  ["invalid quote transition", "That change is not allowed for this quote"],
  ["only org_admin can approve", "Only an administrator can approve discounts"],
  ["at least one line", "A quote needs at least one line"],
  ["validity date has already passed", "The validity date has already passed"],
  ["price list is no longer approved", "The price list is no longer approved"],
  ["no longer backed by approved evidence", "A line is no longer backed by approved evidence; remove it and add it again"],
  ["discount above the limit", "A discount above the limit needs an administrator's current approval"],
  ["quote has expired", "The quote has expired"],
  ["price must come from", "The price must come from an approved price list entry"],
  ["item must be approved", "The item is not approved"],
];
function mapDbError(e: unknown): never {
  const m = String((e as { message?: string }).message ?? "");
  const hit = DB_RULES.find(([needle]) => m.includes(needle));
  if (hit) throw conflict(hit[1]);
  throw e;
}

type QuoteRow = {
  id: string; number: number; opportunity_id: string; status: string; price_list_id: string; currency: string; valid_until: Date | null;
  tax_rate: { toFixed(n: number): string } | null; notes: string | null; subtotal: { toFixed(n: number): string }; discount_total: { toFixed(n: number): string };
  tax_total: { toFixed(n: number): string }; total: { toFixed(n: number): string }; discount_approved_at: Date | null; sent_at: Date | null; decided_at: Date | null; created_at: Date;
};
type LineRow = {
  id: string; position: number; sku: string; item_name: string; item_version: number; unit: string | null; quantity: { toFixed(n: number): string };
  unit_price: { toFixed(n: number): string }; discount_percent: { toFixed(n: number): string }; gross: { toFixed(n: number): string };
  discount_amount: { toFixed(n: number): string }; line_total: { toFixed(n: number): string }; item_ref: string; price_ref: string;
};

/** Quotes are built only from approved evidence, computed with exact decimals, approved when discounts exceed the limit, and frozen once sent. */
@Injectable()
export class QuotesService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EvidenceService) private readonly evidence: EvidenceService,
  ) {}

  /* ---------- settings ---------- */

  getSettings(auth: AuthContext): Promise<QuoteSettingsDto> {
    return this.db.withTenant(auth, async (tx) => ({ maxDiscountPercent: (await this.maxDiscount(tx, auth)).toFixed(2) }));
  }

  setSettings(auth: AuthContext, input: SetQuoteSettingsRequest): Promise<QuoteSettingsDto> {
    return this.db.withTenant(auth, async (tx) => {
      const existing = await tx.quoteSettings.findUnique({ where: { organization_id: auth.organizationId } });
      if (existing) await tx.quoteSettings.update({ where: { organization_id: auth.organizationId }, data: { max_discount_percent: input.maxDiscountPercent, updated_by: auth.userId } });
      else await tx.quoteSettings.create({ data: { organization_id: auth.organizationId, max_discount_percent: input.maxDiscountPercent, updated_by: auth.userId } });
      await this.audit.record(tx, auth, { action: "quotes.settings_changed", resourceType: "quote_settings", metadata: { maxDiscountPercent: input.maxDiscountPercent } });
      return { maxDiscountPercent: Number(input.maxDiscountPercent).toFixed(2) };
    });
  }

  /* ---------- quotes ---------- */

  list(auth: AuthContext, q: QuoteListQuery): Promise<QuotePageDto> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.quote.findMany({
        where: { organization_id: auth.organizationId, ...(q.status !== "all" ? { status: q.status } : {}), ...(q.opportunityId ? { opportunity_id: q.opportunityId } : {}), ...(q.cursor ? { id: { gt: q.cursor } } : {}) },
        orderBy: { id: "asc" },
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const limit = await this.maxDiscount(tx, auth);
      const lines = page.length ? await tx.quoteLine.findMany({ where: { organization_id: auth.organizationId, quote_id: { in: page.map((r) => r.id) } }, select: { quote_id: true, discount_percent: true } }) : [];
      return {
        items: page.map((r) => this.dto(r, lines.filter((l) => l.quote_id === r.id).map((l) => Number(l.discount_percent)), limit)),
        nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    });
  }

  get(auth: AuthContext, id: string): Promise<QuoteDetailDto> {
    return this.db.withTenant(auth, (tx) => this.load(tx, auth, id));
  }

  create(auth: AuthContext, input: CreateQuoteRequest): Promise<QuoteDetailDto> {
    return this.db
      .withTenant(auth, async (tx) => {
        const opp = await tx.opportunity.findFirst({ where: { id: input.opportunityId, organization_id: auth.organizationId }, select: { id: true, stage: true } });
        if (!opp) throw new NotFoundException();
        if (opp.stage === "won" || opp.stage === "lost") throw conflict("Quotes need an open opportunity");
        const list = await tx.priceList.findFirst({ where: { id: input.priceListId, organization_id: auth.organizationId } });
        if (!list) throw new NotFoundException();
        if (list.status !== "approved") throw conflict("Quotes need an approved price list");
        const next = await tx.$queryRaw<Array<{ last_number: number }>>`INSERT INTO quote_counters (organization_id, last_number) VALUES (${auth.organizationId}::uuid, 1)
          ON CONFLICT (organization_id) DO UPDATE SET last_number = quote_counters.last_number + 1 RETURNING last_number`;
        const row = await tx.quote.create({
          data: {
            organization_id: auth.organizationId, opportunity_id: opp.id, number: next[0]?.last_number ?? 1, price_list_id: list.id, currency: list.currency,
            valid_until: asDate(input.validUntil) ?? null, tax_rate: input.taxRate ?? null, notes: input.notes ?? null, created_by: auth.userId,
          },
        });
        await this.audit.record(tx, auth, { action: "quote.created", resourceType: "quote", resourceId: row.id, metadata: { number: row.number, priceListId: list.id } });
        return this.load(tx, auth, row.id);
      })
      .catch(mapDbError);
  }

  update(auth: AuthContext, id: string, input: UpdateQuoteRequest): Promise<QuoteDetailDto> {
    return this.db
      .withTenant(auth, async (tx) => {
        await this.lock(tx, auth, id);
        await tx.quote.update({
          where: { id },
          data: {
            ...(input.validUntil !== undefined ? { valid_until: asDate(input.validUntil) ?? null } : {}),
            ...(input.taxRate !== undefined ? { tax_rate: input.taxRate } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
          },
        });
        await this.recalc(tx, auth, id);
        await this.audit.record(tx, auth, { action: "quote.updated", resourceType: "quote", resourceId: id, metadata: { changedFields: Object.keys(input) } });
        return this.load(tx, auth, id);
      })
      .catch(mapDbError);
  }

  async addLine(auth: AuthContext, id: string, input: AddQuoteLineRequest): Promise<QuoteDetailDto> {
    const quote = await this.db.withTenant(auth, (tx) => this.requireQuote(tx, auth, id));
    // The ONLY source of commercial facts is the evidence contract: approved item + price of the quote's approved list.
    const ev = await this.evidence.lookup(auth, { sku: input.sku, priceListId: quote.price_list_id });
    if (ev.item.status !== "evidence" || ev.price?.status !== "evidence") {
      throw conflict("There is no approved evidence for that SKU in the quote's price list", {
        item: ev.item.status === "evidence" ? "ok" : ev.item.reason,
        price: ev.price?.status === "evidence" ? "ok" : (ev.price?.reason ?? "no_price_for_item"),
      });
    }
    const item = ev.item;
    const price = ev.price;
    const qty = toScaled(input.quantity);
    const unitPrice = toScaled(price.unitPrice);
    const pct = toScaled(input.discountPercent ?? "0", 2);
    const g = gross(qty, unitPrice);
    const d = discountAmount(g, pct);
    return this.db
      .withTenant(auth, async (tx) => {
        await this.lock(tx, auth, id);
        const last = await tx.quoteLine.aggregate({ where: { organization_id: auth.organizationId, quote_id: id }, _max: { position: true } });
        try {
          await tx.quoteLine.create({
            data: {
              organization_id: auth.organizationId, quote_id: id, position: (last._max.position ?? 0) + 1, item_id: item.itemId, sku: item.sku, item_name: item.name, item_version: item.version,
              unit: item.unit, item_ref: item.ref, price_ref: price.ref, quantity: fmt4(qty), unit_price: fmt4(unitPrice), discount_percent: fmt2(pct),
              gross: fmt4(g), discount_amount: fmt4(d), line_total: fmt4(g - d),
            },
          });
        } catch (e) {
          if ((e as { code?: string }).code === "P2002") throw conflict("That SKU is already on the quote");
          throw e;
        }
        await this.recalc(tx, auth, id);
        await this.audit.record(tx, auth, { action: "quote.line_added", resourceType: "quote", resourceId: id, metadata: { sku: item.sku, itemRef: item.ref, priceRef: price.ref } });
        return this.load(tx, auth, id);
      })
      .catch(mapDbError);
  }

  removeLine(auth: AuthContext, id: string, lineId: string): Promise<QuoteDetailDto> {
    return this.db
      .withTenant(auth, async (tx) => {
        await this.lock(tx, auth, id);
        const removed = await tx.quoteLine.deleteMany({ where: { id: lineId, quote_id: id, organization_id: auth.organizationId } });
        if (removed.count === 0) throw new NotFoundException();
        await this.recalc(tx, auth, id);
        await this.audit.record(tx, auth, { action: "quote.line_removed", resourceType: "quote", resourceId: id, metadata: { lineId } });
        return this.load(tx, auth, id);
      })
      .catch(mapDbError);
  }

  approveDiscount(auth: AuthContext, id: string): Promise<QuoteDetailDto> {
    return this.db
      .withTenant(auth, async (tx) => {
        const quote = await this.lock(tx, auth, id);
        const limit = await this.maxDiscount(tx, auth);
        const lines = await tx.quoteLine.findMany({ where: { organization_id: auth.organizationId, quote_id: id }, select: { discount_percent: true } });
        if (!lines.some((l) => Number(l.discount_percent) > limit)) throw conflict("No line has a discount above the limit");
        const hash = (await tx.$queryRaw<Array<{ h: string }>>`SELECT quote_lines_hash(${id}::uuid) AS h`)[0]?.h ?? "";
        await tx.quote.update({ where: { id: quote.id }, data: { discount_approved_by: auth.userId, discount_approved_at: new Date(), lines_hash: hash } });
        await this.audit.record(tx, auth, { action: "quote.discount_approved", resourceType: "quote", resourceId: id });
        return this.load(tx, auth, id);
      })
      .catch(mapDbError);
  }

  send(auth: AuthContext, id: string): Promise<QuoteDetailDto> {
    return this.db
      .withTenant(auth, async (tx) => {
        const quote = await this.lock(tx, auth, id);
        await this.recalc(tx, auth, id); // exact figures right before freezing; the database re-computes and compares them
        await tx.quote.update({ where: { id }, data: { status: "sent" } });
        await this.advanceOpportunity(tx, quote.opportunity_id, "quote_sent", `Cotización Q-${String(quote.number).padStart(4, "0")} enviada`);
        await this.audit.record(tx, auth, { action: "quote.sent", resourceType: "quote", resourceId: id, metadata: { number: quote.number } });
        return this.load(tx, auth, id);
      })
      .catch(mapDbError);
  }

  decide(auth: AuthContext, id: string, input: QuoteDecisionRequest): Promise<QuoteDetailDto> {
    return this.db
      .withTenant(auth, async (tx) => {
        const quote = await this.lock(tx, auth, id);
        if (input.decision !== "cancel" && quote.status !== "sent") throw conflict("Only a sent quote can be accepted or rejected");
        if (quote.status === "accepted" || quote.status === "rejected" || quote.status === "cancelled") throw conflict("The quote is already closed");
        const status = input.decision === "accept" ? "accepted" : input.decision === "reject" ? "rejected" : "cancelled";
        await tx.quote.update({ where: { id }, data: { status, decision_note: input.note ?? null } });
        if (status === "accepted") {
          const opp = await tx.opportunity.findFirstOrThrow({ where: { id: quote.opportunity_id, organization_id: auth.organizationId } });
          if (!(await this.advanceOpportunity(tx, opp.id, "won", `Cotización Q-${String(quote.number).padStart(4, "0")} aceptada`))) {
            throw conflict("The opportunity cannot be won from its current stage");
          }
          const fresh = await tx.quote.findFirstOrThrow({ where: { id } });
          await tx.sale.create({
            data: { organization_id: auth.organizationId, quote_id: id, opportunity_id: opp.id, lead_id: opp.lead_id, prospect_id: opp.prospect_id, total: fresh.total, currency: fresh.currency, closed_by: auth.userId },
          });
        }
        await this.audit.record(tx, auth, { action: `quote.${status}`, resourceType: "quote", resourceId: id, metadata: { number: quote.number } });
        return this.load(tx, auth, id);
      })
      .catch(mapDbError);
  }

  listSales(auth: AuthContext, q: PageQuery): Promise<SalePageDto> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.sale.findMany({
        where: { organization_id: auth.organizationId, ...(q.cursor ? { id: { gt: q.cursor } } : {}) },
        orderBy: { id: "asc" },
        take: q.limit + 1,
        include: { quote: { select: { number: true } } },
      });
      const page = rows.slice(0, q.limit);
      return {
        items: page.map((s) => ({
          id: s.id, quoteId: s.quote_id, quoteNumber: s.quote.number, opportunityId: s.opportunity_id, leadId: s.lead_id, prospectId: s.prospect_id,
          total: dec(s.total), currency: s.currency, closedAt: s.closed_at.toISOString(),
        })),
        nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    });
  }

  /* ---------- internals ---------- */

  private async advanceOpportunity(tx: Tx, opportunityId: string, target: string, note: string): Promise<boolean> {
    const opp = await tx.opportunity.findFirst({ where: { id: opportunityId } });
    if (!opp) return false;
    if (opp.stage === target) return true;
    const allowed = (await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT crm_stage_allowed(${opp.stage}, ${target}) AS ok`)[0]?.ok === true;
    if (!allowed) return false;
    await tx.$executeRaw`SELECT set_config('app.stage_note', ${note}, true)`;
    await tx.opportunity.update({ where: { id: opportunityId }, data: { stage: target } });
    return true;
  }

  private async recalc(tx: Tx, auth: AuthContext, id: string): Promise<void> {
    const quote = await tx.quote.findFirstOrThrow({ where: { id, organization_id: auth.organizationId } });
    const lines = await tx.quoteLine.findMany({ where: { organization_id: auth.organizationId, quote_id: id }, select: { gross: true, discount_amount: true } });
    const t = totals(lines.map((l) => ({ gross: toScaled(dec(l.gross)), discountAmount: toScaled(dec(l.discount_amount)) })), quote.tax_rate ? toScaled(dec(quote.tax_rate)) : null);
    await tx.quote.update({ where: { id }, data: { subtotal: fmt4(t.subtotal), discount_total: fmt4(t.discountTotal), tax_total: fmt4(t.taxTotal), total: fmt4(t.total) } });
  }

  /** Row lock; invisible quotes (other tenant, or a seller's non-assigned opportunity) are a plain 404. */
  private async lock(tx: Tx, auth: AuthContext, id: string) {
    const visible = await tx.quote.findFirst({ where: { id, organization_id: auth.organizationId }, select: { id: true } });
    if (!visible) throw new NotFoundException();
    await tx.$queryRaw`SELECT id FROM quotes WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.quote.findFirstOrThrow({ where: { id } });
  }

  private async requireQuote(tx: Tx, auth: AuthContext, id: string) {
    const q = await tx.quote.findFirst({ where: { id, organization_id: auth.organizationId } });
    if (!q) throw new NotFoundException();
    if (q.status !== "draft") throw conflict("The quote is not a draft");
    return q;
  }

  private async maxDiscount(tx: Tx, auth: AuthContext): Promise<number> {
    return Number((await tx.quoteSettings.findUnique({ where: { organization_id: auth.organizationId } }))?.max_discount_percent ?? 0);
  }

  private async load(tx: Tx, auth: AuthContext, id: string): Promise<QuoteDetailDto> {
    const row = await tx.quote.findFirst({ where: { id, organization_id: auth.organizationId } });
    if (!row) throw new NotFoundException();
    const [lines, limit] = await Promise.all([
      tx.quoteLine.findMany({ where: { organization_id: auth.organizationId, quote_id: id }, orderBy: { position: "asc" } }),
      this.maxDiscount(tx, auth),
    ]);
    return { ...this.dto(row, lines.map((l) => Number(l.discount_percent)), limit), lines: lines.map(lineDto) };
  }

  private dto(r: QuoteRow, discounts: number[], limit: number): QuoteDto {
    return {
      id: r.id, number: r.number, label: `Q-${String(r.number).padStart(4, "0")}`, opportunityId: r.opportunity_id, status: r.status as QuoteDto["status"], priceListId: r.price_list_id,
      currency: r.currency, validUntil: dayOf(r.valid_until), taxRate: r.tax_rate ? dec(r.tax_rate) : null, notes: r.notes, subtotal: dec(r.subtotal), discountTotal: dec(r.discount_total),
      taxTotal: dec(r.tax_total), total: dec(r.total), requiresDiscountApproval: discounts.some((d) => d > limit), discountApproved: r.discount_approved_at !== null,
      sentAt: r.sent_at?.toISOString() ?? null, decidedAt: r.decided_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(),
    };
  }
}

const lineDto = (l: LineRow): QuoteLineDto => ({
  id: l.id, position: l.position, sku: l.sku, itemName: l.item_name, itemVersion: l.item_version, unit: l.unit, quantity: dec(l.quantity), unitPrice: dec(l.unit_price),
  discountPercent: dec(l.discount_percent, 2), gross: dec(l.gross), discountAmount: dec(l.discount_amount), lineTotal: dec(l.line_total), itemRef: l.item_ref, priceRef: l.price_ref,
});

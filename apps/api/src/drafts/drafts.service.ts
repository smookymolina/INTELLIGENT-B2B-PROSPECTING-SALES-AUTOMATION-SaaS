import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  DRAFT_LIMITS,
  type CreateDraftRequest,
  type DraftListQuery,
  type MessageDraftDto,
  type MessageDraftPageDto,
  type OutreachContextDto,
  type RejectDraftRequest,
} from "@prospecting/contracts";
import { ungroundedNumbers } from "../ai/safety.js";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { evaluateContacts } from "../campaigns/eligibility.js";
import { EvidenceService, itemRef, priceRef } from "../catalog/evidence.service.js";
import { PrismaService, type Tx } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";
import { ProspectsService } from "../prospects/prospects.service.js";

type Channel = "email" | "whatsapp";
const CHANNELS: readonly Channel[] = ["email", "whatsapp"];
const conflict = (message: string) => new ApiException(409, "CONFLICT", message);
const invalid = (message: string) => new ApiException(400, "VALIDATION_FAILED", message);
const dbMessage = (e: unknown) => String((e as { message?: string }).message ?? "");
const NIL_CAMPAIGN = { id: "00000000-0000-0000-0000-000000000000", min_days_between: 0 };
const MAX_CONTEXT_EVIDENCE = 25;

function mapDbError(e: unknown): never {
  const m = dbMessage(e);
  if (m.includes("invalid draft transition")) throw conflict("That draft was already decided");
  if (m.includes("cannot decide drafts") || m.includes("row-level security") || m.includes("insufficient_privilege") || (e as { code?: string }).code === "P2025") {
    throw new ApiException(403, "FORBIDDEN", "Not allowed");
  }
  if (m.includes("message_drafts_")) throw invalid("The draft does not satisfy the length or channel rules");
  throw e;
}

type Row = {
  id: string; contact_id: string; channel: string; subject: string | null; body: string; evidence_refs: string[]; status: string; author_kind: string;
  created_by: string; created_at: Date; decided_by: string | null; decided_at: Date | null; decision_note: string | null;
};
const toDto = (r: Row): MessageDraftDto => ({
  id: r.id, contactId: r.contact_id, channel: r.channel as MessageDraftDto["channel"], subject: r.subject, body: r.body, evidenceRefs: r.evidence_refs,
  status: r.status as MessageDraftDto["status"], authorKind: r.author_kind as MessageDraftDto["authorKind"], createdBy: r.created_by, createdAt: r.created_at.toISOString(),
  decidedBy: r.decided_by, decidedAt: r.decided_at?.toISOString() ?? null, decisionNote: r.decision_note,
});

/** Never show a full address to a drafter: the first character (email) or the last two digits (phone) is enough to recognise it. */
export function maskAddress(address: string): string {
  const at = address.indexOf("@");
  if (at > 0) return `${address[0]}***${address.slice(at)}`;
  return `***${address.slice(-2)}`;
}

type EvidenceItem = { ref: string; kind: string; summary: string };
const summarise = (e: Record<string, unknown>): EvidenceItem => {
  const ref = String(e.ref);
  if (ref.startsWith("price:")) return { ref, kind: "price", summary: `Unit price ${String(e.unitPrice)} ${String(e.currency)}${e.validUntil ? ` until ${String(e.validUntil)}` : ""}` };
  const features = e.features && typeof e.features === "object" && Object.keys(e.features).length ? ` | ${JSON.stringify(e.features)}` : "";
  const description = e.description ? `: ${String(e.description)}` : "";
  return { ref, kind: String(e.kind ?? "item"), summary: `${String(e.name)} (${String(e.sku)})${e.unit ? ` per ${String(e.unit)}` : ""}${description}${features}`.slice(0, 600) };
};

/** Text a figure may be traced to: what the fact says, never identifiers or timestamps (their digits would ground invented numbers). */
const factText = (e: Record<string, unknown>): string =>
  [e.name, e.description, e.unit, e.unitPrice, e.validFrom, e.validUntil, e.features ? JSON.stringify(e.features) : ""].filter((v) => v !== undefined && v !== null).join(" ");

/**
 * Personalised drafts. A draft is text for a human to review: nothing here sends, and `authorKind` only records provenance (it grants nothing).
 * Creating needs an eligible contact for that channel and approved evidence; approving re-checks eligibility because consent can change in between.
 */
@Injectable()
export class DraftsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ProspectsService) private readonly prospects: ProspectsService,
    @Inject(EvidenceService) private readonly evidence: EvidenceService,
  ) {}

  /** null = eligible; otherwise the reason. A contact belongs to one channel, so any other channel is simply not available for it. */
  private async verdict(tx: Tx, auth: AuthContext, contact: { id: string; channel: string }, channel: Channel): Promise<string | null> {
    if (contact.channel !== channel) return "channel_mismatch";
    const verdicts = await evaluateContacts(tx, auth.organizationId, NIL_CAMPAIGN, await this.prospects.suppressionSets(tx, auth), { contactIds: [contact.id], ignoreOwnAttempts: true, channel });
    return verdicts.get(contact.id) ?? null;
  }

  private async channelsFor(tx: Tx, auth: AuthContext, contact: { id: string; channel: string }): Promise<OutreachContextDto["channels"]> {
    const out = {} as OutreachContextDto["channels"];
    for (const ch of CHANNELS) {
      const reason = await this.verdict(tx, auth, contact, ch);
      out[ch] = { eligible: reason === null, reasons: reason ? [reason] : [] };
    }
    return out;
  }

  /** Approved, current catalog facts only (same source as /catalog/evidence). */
  private async approvedEvidence(auth: AuthContext): Promise<EvidenceItem[]> {
    const refs = await this.db.withTenant(auth, async (tx) => {
      const items = await tx.catalogItem.findMany({
        where: { organization_id: auth.organizationId, archived_at: null, approved_version: { not: null } },
        select: { id: true, approved_version: true },
        orderBy: { id: "asc" },
        take: MAX_CONTEXT_EVIDENCE,
      });
      const entries = await tx.priceListEntry.findMany({
        where: { organization_id: auth.organizationId, price_list: { status: "approved" }, item_id: { in: items.map((i) => i.id) } },
        select: { id: true },
        orderBy: { id: "asc" },
        take: MAX_CONTEXT_EVIDENCE,
      });
      return [...items.map((i) => itemRef(i.id, i.approved_version as number)), ...entries.map((e) => priceRef(e.id))];
    });
    if (refs.length === 0) return [];
    const { results } = await this.evidence.resolve(auth, { refs });
    return results.filter((r) => r.status === "current" && r.evidence).map((r) => summarise(r.evidence as unknown as Record<string, unknown>));
  }

  async context(auth: AuthContext, contactId: string): Promise<OutreachContextDto> {
    const evidence = await this.approvedEvidence(auth);
    return this.db.withTenant(auth, async (tx) => {
      const contact = await tx.contact.findFirst({ where: { id: contactId, organization_id: auth.organizationId } });
      if (!contact) throw new NotFoundException();
      const prospect = await tx.prospect.findFirst({ where: { id: contact.prospect_id, organization_id: auth.organizationId } });
      if (!prospect) throw new NotFoundException();
      const channels = await this.channelsFor(tx, auth, contact);
      await this.audit.record(tx, auth, { action: "draft.context_read", resourceType: "contact", resourceId: contactId });
      return {
        contactId,
        channels,
        contact: { displayName: contact.display_name, addressMasked: maskAddress(contact.address), channel: contact.channel as Channel, source: contact.source },
        prospect: { name: prospect.name, industry: prospect.industry, country: prospect.country, city: prospect.city },
        evidence,
        constraints: {
          email: { subjectMax: DRAFT_LIMITS.email.subjectMax, bodyMax: DRAFT_LIMITS.email.bodyMax },
          whatsapp: { bodyMax: DRAFT_LIMITS.whatsapp.bodyMax, templateOnly: true, note: "WhatsApp outside the 24h window needs a pre-approved template; this is a template draft, nothing is sent." },
        },
      };
    });
  }

  async create(auth: AuthContext, input: CreateDraftRequest, clientKind: string | undefined): Promise<MessageDraftDto> {
    const refs = [...new Set(input.evidenceRefs)];
    const facts: string[] = [];
    if (refs.length) {
      const { results } = await this.evidence.resolve(auth, { refs });
      const bad = results.filter((r) => r.status !== "current" || !r.evidence);
      if (bad.length) throw invalid(`Evidence is not approved or not current: ${bad.map((b) => b.ref).join(", ").slice(0, 300)}`);
      for (const r of results) facts.push(factText(r.evidence as unknown as Record<string, unknown>));
    }
    return this.db
      .withTenant(auth, async (tx) => {
        const contact = await tx.contact.findFirst({ where: { id: input.contactId, organization_id: auth.organizationId } });
        if (!contact) throw new NotFoundException();
        const reason = await this.verdict(tx, auth, contact, input.channel);
        if (reason) throw conflict(`The contact is not eligible for ${input.channel}: ${reason}`);
        const prospect = await tx.prospect.findFirst({ where: { id: contact.prospect_id, organization_id: auth.organizationId } });
        const ungrounded = ungroundedNumbers(`${input.subject ?? ""} ${input.body}`, ...facts, prospect?.name ?? "", prospect?.city ?? "");
        if (ungrounded.length) throw invalid(`These figures are not backed by the cited evidence: ${ungrounded.slice(0, 5).join(", ")}`);
        const row = await tx.messageDraft.create({
          data: {
            organization_id: auth.organizationId, contact_id: contact.id, channel: input.channel, subject: input.channel === "email" ? (input.subject ?? null) : null,
            body: input.body, evidence_refs: refs, author_kind: clientKind === "mcp" ? "mcp" : "human", created_by: auth.userId,
          },
        });
        await this.audit.record(tx, auth, { action: "draft.created", resourceType: "message_draft", resourceId: row.id, metadata: { channel: input.channel, authorKind: row.author_kind, evidenceRefs: refs.length } });
        return toDto(row);
      })
      .catch(mapDbError);
  }

  list(auth: AuthContext, q: DraftListQuery): Promise<MessageDraftPageDto> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.messageDraft.findMany({
        where: { organization_id: auth.organizationId, ...(q.status ? { status: q.status } : {}), ...(q.contactId ? { contact_id: q.contactId } : {}), ...(q.cursor ? { id: { gt: q.cursor } } : {}) },
        orderBy: { id: "asc" },
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      return { items: page.map(toDto), nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
    });
  }

  get(auth: AuthContext, id: string): Promise<MessageDraftDto> {
    return this.db.withTenant(auth, async (tx) => toDto(await this.require(tx, auth, id)));
  }

  approve(auth: AuthContext, id: string): Promise<MessageDraftDto> {
    return this.db
      .withTenant(auth, async (tx) => {
        const d = await this.require(tx, auth, id);
        if (d.status !== "pending_review") throw conflict("Only a draft pending review can be decided");
        const contact = await tx.contact.findFirst({ where: { id: d.contact_id, organization_id: auth.organizationId } });
        const reason = contact ? await this.verdict(tx, auth, contact, d.channel as Channel) : "contact_missing";
        if (reason) throw conflict(`The contact is no longer eligible for ${d.channel}: ${reason}`);
        const row = await tx.messageDraft.update({ where: { id }, data: { status: "approved" } });
        await this.audit.record(tx, auth, { action: "draft.approved", resourceType: "message_draft", resourceId: id });
        return toDto(row);
      })
      .catch(mapDbError);
  }

  reject(auth: AuthContext, id: string, input: RejectDraftRequest): Promise<MessageDraftDto> {
    return this.db
      .withTenant(auth, async (tx) => {
        const d = await this.require(tx, auth, id);
        if (d.status !== "pending_review") throw conflict("Only a draft pending review can be decided");
        const row = await tx.messageDraft.update({ where: { id }, data: { status: "rejected", decision_note: input.note } });
        await this.audit.record(tx, auth, { action: "draft.rejected", resourceType: "message_draft", resourceId: id });
        return toDto(row);
      })
      .catch(mapDbError);
  }

  private async require(tx: Tx, auth: AuthContext, id: string): Promise<Row> {
    const row = await tx.messageDraft.findFirst({ where: { id, organization_id: auth.organizationId } });
    if (!row) throw new NotFoundException();
    return row;
  }
}

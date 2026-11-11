import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { WHATSAPP_LINKS_PER_HOUR_DEFAULT, type WhatsAppLinkDto, type WhatsAppManualStatusDto, type WhatsAppMarkSentDto } from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { evaluateContacts } from "../campaigns/eligibility.js";
import { PrismaService, type Tx } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";
import { ProspectsService } from "../prospects/prospects.service.js";

const conflict = (message: string) => new ApiException(409, "CONFLICT", message);
const NIL_CAMPAIGN = { id: "00000000-0000-0000-0000-000000000000", min_days_between: 0 };
const HOUR = 3_600_000;

export const linksPerHour = (): number => {
  const n = Number(process.env.WHATSAPP_LINKS_PER_USER_HOUR);
  return Number.isInteger(n) && n >= 1 ? n : WHATSAPP_LINKS_PER_HOUR_DEFAULT;
};

/** Canal manual: enlace wa.me con el mensaje ya codificado. Solo lleva el cuerpo del borrador; nada de otros prospectos. */
export function buildWaLink(phoneE164: string, body: string): string {
  return `https://wa.me/${phoneE164.replace(/\D/g, "")}?text=${encodeURIComponent(body)}`;
}

/**
 * WhatsApp sin automatizar: el sistema NO envia. Genera el enlace de un borrador aprobado (revalidando consentimiento, supresion y ritmo) y registra,
 * una sola vez, que la persona lo envio desde su propio numero.
 */
@Injectable()
export class WhatsAppManualService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ProspectsService) private readonly prospects: ProspectsService,
  ) {}

  private async draft(tx: Tx, auth: AuthContext, id: string) {
    const d = await tx.messageDraft.findFirst({ where: { id, organization_id: auth.organizationId } });
    if (!d) throw new NotFoundException();
    if (d.channel !== "whatsapp") throw conflict("Only WhatsApp drafts have a manual link");
    return d;
  }

  private async sentAt(tx: Tx, auth: AuthContext, draftId: string): Promise<Date | null> {
    const rows = await tx.$queryRaw<Array<{ created_at: Date }>>`SELECT created_at FROM whatsapp_manual_events WHERE organization_id = ${auth.organizationId}::uuid AND draft_id = ${draftId}::uuid AND kind = 'sent'`;
    return rows[0]?.created_at ?? null;
  }

  private async linkCount(tx: Tx, auth: AuthContext, draftId: string): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM whatsapp_manual_events WHERE organization_id = ${auth.organizationId}::uuid AND draft_id = ${draftId}::uuid AND kind = 'link'`;
    return Number(rows[0]?.n ?? 0);
  }

  /** Distinct drafts this user opened or marked in the last hour. */
  private async used(tx: Tx, auth: AuthContext): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ draft_id: string }>>`SELECT DISTINCT draft_id FROM whatsapp_manual_events WHERE organization_id = ${auth.organizationId}::uuid AND user_id = ${auth.userId}::uuid AND created_at > ${new Date(Date.now() - HOUR)}`;
    return rows.map((r) => r.draft_id);
  }

  status(auth: AuthContext, id: string): Promise<WhatsAppManualStatusDto> {
    return this.db.withTenant(auth, async (tx) => {
      await this.draft(tx, auth, id);
      const sent = await this.sentAt(tx, auth, id);
      if (sent) return { draftId: id, state: "sent_manual", sentAt: sent.toISOString() };
      return { draftId: id, state: (await this.linkCount(tx, auth, id)) > 0 ? "link_opened" : "none", sentAt: null };
    });
  }

  link(auth: AuthContext, id: string): Promise<WhatsAppLinkDto> {
    return this.db.withTenant(auth, async (tx) => {
      const d = await this.draft(tx, auth, id);
      if (d.status !== "approved") throw conflict("Only an approved draft can be opened in WhatsApp");
      if (await this.sentAt(tx, auth, id)) throw conflict("That draft was already marked as sent");
      const contact = await tx.contact.findFirst({ where: { id: d.contact_id, organization_id: auth.organizationId } });
      if (!contact || contact.channel !== "whatsapp") throw conflict("The contact is no longer eligible for whatsapp: contact_missing");
      // Consent, opt-out and suppression are checked again NOW: they may have changed since the approval.
      const verdicts = await evaluateContacts(tx, auth.organizationId, NIL_CAMPAIGN, await this.prospects.suppressionSets(tx, auth), { contactIds: [contact.id], ignoreOwnAttempts: true, channel: "whatsapp" });
      const found = verdicts.get(contact.id);
      const reason = found === undefined ? "no_consent" : found;
      if (reason !== null) throw conflict(`The contact is no longer eligible for whatsapp: ${reason}`);
      const limit = linksPerHour();
      const used = await this.used(tx, auth);
      if (!used.includes(id) && used.length >= limit) throw new ApiException(429, "RATE_LIMITED", `Hourly WhatsApp limit reached (${limit}); try again later`, null, { "retry-after": "600" });
      await tx.$executeRaw`INSERT INTO whatsapp_manual_events (organization_id, draft_id, contact_id, user_id, kind) VALUES (${auth.organizationId}::uuid, ${id}::uuid, ${contact.id}::uuid, ${auth.userId}::uuid, 'link')`;
      await this.audit.record(tx, auth, { action: "draft.whatsapp_link", resourceType: "message_draft", resourceId: id });
      return { draftId: id, url: buildWaLink(contact.address, d.body), linksUsedThisHour: new Set([...used, id]).size, linksPerHour: limit };
    });
  }

  markSent(auth: AuthContext, id: string): Promise<WhatsAppMarkSentDto> {
    return this.db.withTenant(auth, async (tx) => {
      const d = await this.draft(tx, auth, id);
      if (d.status !== "approved") throw conflict("Only an approved draft can be marked as sent");
      const existing = await this.sentAt(tx, auth, id);
      if (existing) return { draftId: id, state: "sent_manual", sentAt: existing.toISOString(), alreadyRecorded: true };
      if ((await this.linkCount(tx, auth, id)) === 0) throw conflict("Open the WhatsApp link first");
      const rows = await tx.$queryRaw<Array<{ created_at: Date }>>`INSERT INTO whatsapp_manual_events (organization_id, draft_id, contact_id, user_id, kind) VALUES (${auth.organizationId}::uuid, ${id}::uuid, ${d.contact_id}::uuid, ${auth.userId}::uuid, 'sent') ON CONFLICT (organization_id, draft_id) WHERE kind = 'sent' DO NOTHING RETURNING created_at`;
      const row = rows[0];
      if (!row) return { draftId: id, state: "sent_manual", sentAt: (await this.sentAt(tx, auth, id))?.toISOString() ?? new Date().toISOString(), alreadyRecorded: true };
      await this.audit.record(tx, auth, { action: "draft.whatsapp_sent_manual", resourceType: "message_draft", resourceId: id, metadata: { delivery: "manual" } });
      return { draftId: id, state: "sent_manual", sentAt: row.created_at.toISOString(), alreadyRecorded: false };
    });
  }
}

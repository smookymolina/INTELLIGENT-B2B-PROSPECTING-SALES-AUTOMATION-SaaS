import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AddContactRequest, ContactDto, ContactListDto, RecordConsentRequest } from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";
import { privacyAddressHash } from "../privacy/address-hash.js";
import { latestConsent } from "./eligibility.js";

type Row = { id: string; prospect_id: string; channel: string; address: string; display_name: string | null; source: string; status: string; created_at: Date };
export const toDto = (r: Row, consent: { event: string; at: Date } | undefined): ContactDto => ({
  id: r.id, prospectId: r.prospect_id, channel: r.channel as ContactDto["channel"], address: r.address, displayName: r.display_name, source: r.source, status: r.status as ContactDto["status"],
  // A restricted or erased contact has no usable consent (nothing may be sent), whatever the ledger says; opted_out/bounced keep the ledger truth.
  ...(r.status === "erased" || r.status === "restricted"
    ? { consent: "none" as const, consentAt: null }
    : { consent: (consent?.event as ContactDto["consent"] | undefined) ?? "none", consentAt: consent?.at.toISOString() ?? null }),
  createdAt: r.created_at.toISOString(),
});

/** Contacts and the consent ledger. A contact never implies consent, and consent is only what a person recorded with its evidence. */
@Injectable()
export class ContactsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  add(auth: AuthContext, prospectId: string, input: AddContactRequest): Promise<ContactDto> {
    return this.db.withTenant(auth, async (tx) => {
      if (!(await tx.prospect.findFirst({ where: { id: prospectId, organization_id: auth.organizationId }, select: { id: true } }))) throw new NotFoundException();
      try {
        const addressKey = input.address.toLowerCase();
        const hash = privacyAddressHash(auth.organizationId, input.channel, addressKey);
        await tx.$executeRaw`SELECT privacy_assert_address_free(${addressKey}, ${hash})`; // 409 if this person asked to be erased
        const row = await tx.contact.create({
          data: { organization_id: auth.organizationId, prospect_id: prospectId, channel: input.channel, address: input.channel === "email" ? input.address.toLowerCase() : input.address, address_key: addressKey, display_name: input.displayName ?? null, source: input.source, created_by: auth.userId },
        });
        await this.audit.record(tx, auth, { action: "contact.created", resourceType: "contact", resourceId: row.id, metadata: { prospectId } });
        return toDto(row, undefined);
      } catch (e) {
        if (String((e as { message?: string }).message ?? "").includes("was erased")) throw new ApiException(409, "CONFLICT", "That address was erased on a data-subject request and cannot be registered again");
        if ((e as { code?: string }).code === "P2002") throw new ApiException(409, "CONFLICT", "That address is already registered as a contact");
        throw e;
      }
    });
  }

  list(auth: AuthContext, prospectId: string): Promise<ContactListDto> {
    return this.db.withTenant(auth, async (tx) => {
      if (!(await tx.prospect.findFirst({ where: { id: prospectId, organization_id: auth.organizationId }, select: { id: true } }))) throw new NotFoundException();
      const rows = await tx.contact.findMany({ where: { organization_id: auth.organizationId, prospect_id: prospectId }, orderBy: { created_at: "asc" } });
      const consent = await latestConsent(tx, auth.organizationId, rows.map((r) => r.id));
      return { items: rows.map((r) => toDto(r, consent.get(r.id))) };
    });
  }

  record(auth: AuthContext, contactId: string, input: RecordConsentRequest): Promise<ContactDto> {
    return this.db.withTenant(auth, async (tx) => {
      if (!(await tx.contact.findFirst({ where: { id: contactId, organization_id: auth.organizationId }, select: { id: true } }))) throw new NotFoundException();
      try {
        await tx.consentEvent.create({
          data: { organization_id: auth.organizationId, contact_id: contactId, event: input.event, evidence: input.evidence, occurred_at: new Date(input.occurredAt), recorded_by: auth.userId },
        });
      } catch (e) {
        if (String((e as { message?: string }).message ?? "").includes("consent_not_future")) throw new ApiException(400, "VALIDATION_FAILED", "The consent date cannot be in the future");
        if (String((e as { message?: string }).message ?? "").includes("was erased")) throw new ApiException(409, "CONFLICT", "The contact was erased: no consent can be recorded");
        throw e;
      }
      await this.audit.record(tx, auth, { action: input.event === "granted" ? "consent.granted" : "consent.withdrawn", resourceType: "contact", resourceId: contactId });
      const row = await tx.contact.findFirstOrThrow({ where: { id: contactId } });
      return toDto(row, (await latestConsent(tx, auth.organizationId, [contactId])).get(contactId));
    });
  }
}

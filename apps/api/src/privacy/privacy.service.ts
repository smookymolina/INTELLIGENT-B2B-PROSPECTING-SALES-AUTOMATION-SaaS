import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  RETENTION_CLASSES,
  RETENTION_DEFAULT_DAYS,
  type ContactDto,
  type CreatePrivacyRequest,
  type PrivacyListQuery,
  type PrivacyRequestDto,
  type PrivacyRequestListDto,
  type RetentionClass,
  type RetentionPolicyDto,
  type RetentionRunDto,
  type SetRetentionRequest,
} from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { latestConsent } from "../campaigns/eligibility.js";
import { toDto as contactDto } from "../campaigns/contacts.service.js";
import { PrismaService, type Tx } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";
import { privacyAddressHash } from "./address-hash.js";

const DAY = 86_400_000;

type ReqRow = {
  id: string; contact_id: string; kind: string; status: string; requested_by: string; requested_at: Date; due_at: Date;
  completed_by: string | null; completed_at: Date | null; note: string | null;
};
const reqDto = (r: ReqRow, accessPackage?: Record<string, unknown>): PrivacyRequestDto => ({
  id: r.id, contactId: r.contact_id, kind: r.kind as PrivacyRequestDto["kind"], status: r.status as PrivacyRequestDto["status"], requestedBy: r.requested_by,
  requestedAt: r.requested_at.toISOString(), dueAt: r.due_at.toISOString(), completedBy: r.completed_by, completedAt: r.completed_at?.toISOString() ?? null, note: r.note,
  ...(accessPackage ? { accessPackage } : {}),
});

/** Translates the database invariants of the privacy workflow into 409s; anything else is a real failure. */
function mapDb(e: unknown): never {
  const msg = String((e as { message?: string }).message ?? "");
  if (/already (exists|erased)|no open .* request|is not restricted|closed request|already erased/.test(msg)) throw new ApiException(409, "CONFLICT", "The request conflicts with the current state of the contact or the request");
  if ((e as { code?: string }).code === "P2002") throw new ApiException(409, "CONFLICT", "An open request of that kind already exists for this contact");
  throw e;
}

/** Retention policy and data-subject rights. Every method is org_admin only (privacy:manage); the database re-checks it. */
@Injectable()
export class PrivacyService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /* ---------- retention ---------- */

  private async policies(tx: Tx, auth: AuthContext): Promise<RetentionPolicyDto> {
    const rows = await tx.retentionPolicy.findMany({ where: { organization_id: auth.organizationId }, orderBy: { data_class: "asc" } });
    return {
      policies: rows.map((r) => ({ dataClass: r.data_class as RetentionClass, retentionDays: r.retention_days, updatedBy: r.updated_by, updatedAt: r.updated_at.toISOString() })),
      available: [...RETENTION_CLASSES],
      effective: RETENTION_CLASSES.map((c) => {
        const own = rows.find((r) => r.data_class === c);
        return own ? { dataClass: c, retentionDays: own.retention_days, source: "policy" as const } : { dataClass: c, retentionDays: RETENTION_DEFAULT_DAYS[c], source: "default" as const };
      }),
    };
  }

  getRetention(auth: AuthContext): Promise<RetentionPolicyDto> {
    return this.db.withTenant(auth, (tx) => this.policies(tx, auth));
  }

  setRetention(auth: AuthContext, input: SetRetentionRequest): Promise<RetentionPolicyDto> {
    return this.db.withTenant(auth, async (tx) => {
      const seen = new Set<string>();
      for (const p of input.policies) {
        if (seen.has(p.dataClass)) throw new ApiException(400, "VALIDATION_FAILED", `Duplicate data class ${p.dataClass}`);
        seen.add(p.dataClass);
        const key = { organization_id: auth.organizationId, data_class: p.dataClass };
        const existing = await tx.retentionPolicy.findUnique({ where: { organization_id_data_class: key } });
        if (existing) await tx.retentionPolicy.update({ where: { organization_id_data_class: key }, data: { retention_days: p.retentionDays, updated_by: auth.userId } });
        else await tx.retentionPolicy.create({ data: { ...key, retention_days: p.retentionDays, updated_by: auth.userId } });
      }
      await this.audit.record(tx, auth, { action: "privacy.retention.set", resourceType: "retention_policy", metadata: { policies: input.policies.map((p) => ({ dataClass: p.dataClass, retentionDays: p.retentionDays })) } });
      return this.policies(tx, auth);
    });
  }

  /**
   * Purges (or, with dryRun, only counts) the expired rows of every class of THIS organization: its own policy, else the default; a class set to 0
   * days is skipped. Runs in the tenant context (RLS); the audit event carries counts only. `now` is injectable (tests, worker clock).
   */
  run(auth: AuthContext, dryRun: boolean, opts: { now?: Date; trigger?: "manual" | "worker" } = {}): Promise<RetentionRunDto> {
    const now = opts.now ?? new Date();
    const trigger = opts.trigger ?? "manual";
    return this.db.withTenant(auth, async (tx) => {
      const classes: RetentionRunDto["classes"] = [];
      const skipped: RetentionClass[] = [];
      for (const cls of RETENTION_CLASSES) {
        const rows = await tx.$queryRaw<{ r: { retentionDays: number; source: "policy" | "default"; cutoff: string; count: number } | null }[]>`SELECT privacy_purge(${cls}, ${dryRun}, ${now}::timestamptz) AS r`;
        const r = rows[0]?.r ?? null;
        if (!r) { skipped.push(cls); continue; }
        classes.push({ dataClass: cls, retentionDays: r.retentionDays, source: r.source, cutoff: new Date(r.cutoff).toISOString(), eligible: r.count, deleted: dryRun ? 0 : r.count });
      }
      const report: RetentionRunDto = { dryRun, ranAt: now.toISOString(), classes, skipped };
      await this.audit.record(tx, auth, { action: dryRun ? "privacy.retention.dry_run" : "privacy.retention.purged", resourceType: "retention_policy", metadata: { trigger, classes: classes.map((c) => ({ dataClass: c.dataClass, retentionDays: c.retentionDays, source: c.source, eligible: c.eligible, deleted: c.deleted })), skipped } });
      return report;
    }, { timeoutMs: 60_000 });
  }

  /* ---------- data-subject requests ---------- */

  create(auth: AuthContext, input: CreatePrivacyRequest): Promise<PrivacyRequestDto> {
    return this.db.withTenant(auth, async (tx) => {
      const contact = await tx.contact.findFirst({ where: { id: input.contactId, organization_id: auth.organizationId }, select: { id: true } });
      if (!contact) throw new NotFoundException();
      try {
        const row = await tx.privacyRequest.create({
          data: { organization_id: auth.organizationId, contact_id: input.contactId, kind: input.kind, requested_by: auth.userId, due_at: new Date(Date.now() + 30 * DAY) },
        });
        await this.audit.record(tx, auth, { action: "privacy.request.created", resourceType: "privacy_request", resourceId: row.id, metadata: { kind: input.kind, contactId: input.contactId } });
        return reqDto(row);
      } catch (e) {
        return mapDb(e);
      }
    });
  }

  list(auth: AuthContext, q: PrivacyListQuery): Promise<PrivacyRequestListDto> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.privacyRequest.findMany({
        where: { organization_id: auth.organizationId, ...(q.status ? { status: q.status } : {}) },
        orderBy: [{ requested_at: "desc" }, { id: "desc" }],
        take: 200,
      });
      return { items: rows.map((r) => reqDto(r)) };
    });
  }

  get(auth: AuthContext, id: string): Promise<PrivacyRequestDto> {
    return this.db.withTenant(auth, async (tx) => {
      const row = await tx.privacyRequest.findFirst({ where: { id, organization_id: auth.organizationId } });
      if (!row) throw new NotFoundException();
      return reqDto(row);
    });
  }

  /** Locks the row so two concurrent completions serialize; the loser sees a closed request and gets a 409. */
  private async lockOpen(tx: Tx, auth: AuthContext, id: string): Promise<ReqRow> {
    await tx.$queryRaw`SELECT id FROM privacy_requests WHERE id = ${id}::uuid AND organization_id = ${auth.organizationId}::uuid FOR UPDATE`;
    const row = await tx.privacyRequest.findFirst({ where: { id, organization_id: auth.organizationId } });
    if (!row) throw new NotFoundException();
    if (row.status !== "open") throw new ApiException(409, "CONFLICT", `The request is already ${row.status}`);
    return row;
  }

  complete(auth: AuthContext, id: string): Promise<PrivacyRequestDto> {
    return this.db.withTenant(auth, async (tx) => {
      const req = await this.lockOpen(tx, auth, id);
      let pkg: Record<string, unknown> | undefined;
      try {
        if (req.kind === "access") pkg = await this.accessPackage(tx, auth, req.contact_id);
        else if (req.kind === "restrict") await tx.$executeRaw`SELECT privacy_restrict_contact(${req.contact_id}::uuid)`;
        else {
          const c = await tx.contact.findFirstOrThrow({ where: { id: req.contact_id, organization_id: auth.organizationId }, select: { channel: true, address_key: true } });
          const hash = privacyAddressHash(auth.organizationId, c.channel, c.address_key);
          await tx.$executeRaw`SELECT privacy_erase_contact(${req.contact_id}::uuid, ${hash})`;
        }
        const done = await tx.privacyRequest.update({ where: { id }, data: { status: "completed" } });
        await this.audit.record(tx, auth, { action: `privacy.${req.kind}.completed`, resourceType: "privacy_request", resourceId: id, metadata: { contactId: req.contact_id } });
        return reqDto(done, pkg);
      } catch (e) {
        return mapDb(e);
      }
    });
  }

  reject(auth: AuthContext, id: string, note: string): Promise<PrivacyRequestDto> {
    return this.db.withTenant(auth, async (tx) => {
      await this.lockOpen(tx, auth, id);
      const done = await tx.privacyRequest.update({ where: { id }, data: { status: "rejected", note } });
      await this.audit.record(tx, auth, { action: "privacy.request.rejected", resourceType: "privacy_request", resourceId: id, metadata: { contactId: done.contact_id } });
      return reqDto(done);
    });
  }

  liftRestriction(auth: AuthContext, contactId: string, note: string): Promise<ContactDto> {
    return this.db.withTenant(auth, async (tx) => {
      if (!(await tx.contact.findFirst({ where: { id: contactId, organization_id: auth.organizationId }, select: { id: true } }))) throw new NotFoundException();
      try {
        const rows = await tx.$queryRaw<{ s: string }[]>`SELECT privacy_lift_restriction(${contactId}::uuid) AS s`;
        await this.audit.record(tx, auth, { action: "privacy.restriction.lifted", resourceType: "contact", resourceId: contactId, metadata: { note, restoredTo: rows[0]?.s ?? null } });
      } catch (e) {
        return mapDb(e);
      }
      const row = await tx.contact.findFirstOrThrow({ where: { id: contactId } });
      return contactDto(row, (await latestConsent(tx, auth.organizationId, [contactId])).get(contactId));
    });
  }

  /** Everything held about the contact. No secrets: no tokens, hashes or internal ids of other people. */
  private async accessPackage(tx: Tx, auth: AuthContext, contactId: string): Promise<Record<string, unknown>> {
    const c = await tx.contact.findFirstOrThrow({ where: { id: contactId, organization_id: auth.organizationId } });
    const [prospect, consent, attempts, drafts] = await Promise.all([
      tx.prospect.findFirst({ where: { id: c.prospect_id, organization_id: auth.organizationId }, select: { id: true, name: true, website: true, country: true, region: true, city: true, industry: true, status: true } }),
      tx.consentEvent.findMany({ where: { organization_id: auth.organizationId, contact_id: contactId }, orderBy: [{ occurred_at: "asc" }, { created_at: "asc" }], select: { event: true, purpose: true, evidence: true, occurred_at: true, created_at: true } }),
      tx.sendAttempt.findMany({ where: { organization_id: auth.organizationId, contact_id: contactId }, orderBy: { created_at: "asc" }, select: { campaign_id: true, state: true, skip_reason: true, attempted_at: true } }),
      tx.messageDraft.findMany({ where: { organization_id: auth.organizationId, contact_id: contactId }, orderBy: { created_at: "asc" }, select: { id: true, channel: true, subject: true, body: true, status: true, created_at: true } }),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      contact: { id: c.id, channel: c.channel, address: c.address, displayName: c.display_name, source: c.source, status: c.status, createdAt: c.created_at.toISOString() },
      prospect,
      consentEvents: consent.map((e) => ({ event: e.event, purpose: e.purpose, evidence: e.evidence, occurredAt: e.occurred_at.toISOString(), recordedAt: e.created_at.toISOString() })),
      sendAttempts: attempts.map((a) => ({ campaignId: a.campaign_id, state: a.state, skipReason: a.skip_reason, attemptedAt: a.attempted_at?.toISOString() ?? null })),
      drafts: drafts.map((d) => ({ id: d.id, channel: d.channel, subject: d.subject, body: d.body, status: d.status, createdAt: d.created_at.toISOString() })),
    };
  }
}

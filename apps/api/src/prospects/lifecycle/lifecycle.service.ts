import { Inject, Injectable } from "@nestjs/common";
import type { CohortListDto, ExpireDueDto, LeadQuotaDto, SetLeadQuotaRequest } from "@prospecting/contracts";
import { AuditService } from "../../audit/audit.service.js";
import type { AuthContext } from "../../auth/auth.types.js";
import { PrismaService } from "../../db/prisma.service.js";

type CohortRow = { month: string; discovered: number; active: number; converted: number; rejected: number; no_reply: number; expired: number };
type QuotaRow = { monthly_lead_quota: number; updated_at: Date };

/**
 * Prospect lifecycle: monthly cohorts, the monthly lead quota and the expiry of prospects that never became a lead.
 * Transitions caused by leads / sequences live in database triggers; expiry is the SECURITY DEFINER function prospects_expire_due (org_admin only).
 * The new columns are not in the Prisma schema, so they are read and written with raw SQL inside the tenant transaction (RLS applies).
 */
@Injectable()
export class LifecycleService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async getQuota(auth: AuthContext): Promise<LeadQuotaDto> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.$queryRaw<QuotaRow[]>`SELECT monthly_lead_quota, updated_at FROM lead_quotas WHERE organization_id = ${auth.organizationId}::uuid`;
      return { monthlyLeadQuota: rows[0]?.monthly_lead_quota ?? null, updatedAt: rows[0]?.updated_at.toISOString() ?? null };
    });
  }

  async setQuota(auth: AuthContext, input: SetLeadQuotaRequest): Promise<LeadQuotaDto> {
    return this.db.withTenant(auth, async (tx) => {
      // INSERT ... ON CONFLICT DO UPDATE only touches the granted columns; RLS (org_admin) is enforced by the database.
      const rows = await tx.$queryRaw<QuotaRow[]>`
        INSERT INTO lead_quotas (organization_id, monthly_lead_quota, updated_by) VALUES (${auth.organizationId}::uuid, ${input.monthlyLeadQuota}, ${auth.userId}::uuid)
        ON CONFLICT (organization_id) DO UPDATE SET monthly_lead_quota = EXCLUDED.monthly_lead_quota, updated_by = EXCLUDED.updated_by, updated_at = now()
        RETURNING monthly_lead_quota, updated_at`;
      await this.audit.record(tx, auth, { action: "prospects.lead_quota.set", resourceType: "lead_quota", metadata: { monthlyLeadQuota: input.monthlyLeadQuota } });
      const r = rows[0] as QuotaRow;
      return { monthlyLeadQuota: r.monthly_lead_quota, updatedAt: r.updated_at.toISOString() };
    });
  }

  /** One row per discovery month (newest first). Expired prospects are kept as anonymised rows, so their counts survive. */
  async cohorts(auth: AuthContext): Promise<CohortListDto> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.$queryRaw<CohortRow[]>`
        SELECT to_char(cohort_month, 'YYYY-MM') AS month, count(*)::int AS discovered,
          (count(*) FILTER (WHERE lifecycle_state = 'active'))::int AS active, (count(*) FILTER (WHERE lifecycle_state = 'converted'))::int AS converted,
          (count(*) FILTER (WHERE lifecycle_state = 'rejected'))::int AS rejected, (count(*) FILTER (WHERE lifecycle_state = 'no_reply'))::int AS no_reply,
          (count(*) FILTER (WHERE lifecycle_state = 'expired'))::int AS expired
        FROM prospects WHERE organization_id = ${auth.organizationId}::uuid GROUP BY cohort_month ORDER BY cohort_month DESC`;
      const quota = (await tx.$queryRaw<QuotaRow[]>`SELECT monthly_lead_quota, updated_at FROM lead_quotas WHERE organization_id = ${auth.organizationId}::uuid`)[0]?.monthly_lead_quota ?? null;
      return {
        monthlyLeadQuota: quota,
        items: rows.map((r) => ({
          month: r.month, discovered: r.discovered, active: r.active, converted: r.converted, rejected: r.rejected, noReply: r.no_reply, expired: r.expired,
          monthlyLeadQuota: quota, quotaUsedPercent: quota ? Math.round((r.converted / quota) * 1000) / 10 : null,
        })),
      };
    });
  }

  /** Expires active prospects past their month that never had a lead (org_admin context; also used by the worker job). Idempotent. */
  async expireDue(auth: AuthContext, now?: Date): Promise<ExpireDueDto> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.$queryRaw<{ r: { expired: number; contactsAnonymized: number } }[]>`SELECT prospects_expire_due(${now ?? null}::timestamptz) AS r`;
      const r = (rows[0] as { r: ExpireDueDto }).r;
      if (r.expired > 0) await this.audit.record(tx, auth, { action: "prospects.expired", resourceType: "prospect", metadata: { expired: r.expired, contactsAnonymized: r.contactsAnonymized } });
      return { expired: r.expired, contactsAnonymized: r.contactsAnonymized };
    });
  }
}

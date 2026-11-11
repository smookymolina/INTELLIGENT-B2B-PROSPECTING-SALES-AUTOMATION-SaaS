import { z } from "zod";

export const PROSPECT_LIFECYCLE_STATES = ["active", "converted", "rejected", "no_reply", "expired"] as const;
export type ProspectLifecycleState = (typeof PROSPECT_LIFECYCLE_STATES)[number];

export const SetLeadQuotaRequest = z.strictObject({ monthlyLeadQuota: z.number().int().min(0).max(1_000_000) });
export type SetLeadQuotaRequest = z.infer<typeof SetLeadQuotaRequest>;

export const LeadQuotaDto = z.object({ monthlyLeadQuota: z.number().int().nullable(), updatedAt: z.iso.datetime().nullable() });
export type LeadQuotaDto = z.infer<typeof LeadQuotaDto>;

export const CohortDto = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  discovered: z.number().int(),
  active: z.number().int(),
  converted: z.number().int(),
  rejected: z.number().int(),
  noReply: z.number().int(),
  expired: z.number().int(),
  monthlyLeadQuota: z.number().int().nullable(),
  /** converted / quota * 100, rounded to one decimal; null when no quota is set or it is 0. */
  quotaUsedPercent: z.number().nullable(),
});
export type CohortDto = z.infer<typeof CohortDto>;

export const CohortListDto = z.object({ items: z.array(CohortDto), monthlyLeadQuota: z.number().int().nullable() });
export type CohortListDto = z.infer<typeof CohortListDto>;

export const ExpireDueDto = z.object({ expired: z.number().int(), contactsAnonymized: z.number().int() });
export type ExpireDueDto = z.infer<typeof ExpireDueDto>;

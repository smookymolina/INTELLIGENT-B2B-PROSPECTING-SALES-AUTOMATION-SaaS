import { createHmac, timingSafeEqual } from "node:crypto";
import { EXCLUSION_REASONS } from "@prospecting/contracts";
import { loadSecurityConfig } from "../config/security.config.js";
import type { Tx } from "../db/prisma.service.js";
import { prospectDto } from "../prospects/prospects.service.js";
import type { SuppressionSets } from "../prospects/prospects.service.js";

export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];
const DAY = 86_400_000;

/** Latest consent event per contact (ledger order: when it happened, then when it was recorded). */
export async function latestConsent(tx: Tx, organizationId: string, contactIds: string[]): Promise<Map<string, { event: string; at: Date }>> {
  const out = new Map<string, { event: string; at: Date }>();
  if (contactIds.length === 0) return out;
  const rows = await tx.consentEvent.findMany({
    where: { organization_id: organizationId, contact_id: { in: contactIds } },
    orderBy: [{ occurred_at: "desc" }, { created_at: "desc" }],
    select: { contact_id: true, event: true, occurred_at: true },
  });
  for (const r of rows) if (!out.has(r.contact_id)) out.set(r.contact_id, { event: r.event, at: r.occurred_at });
  return out;
}

/**
 * Why a contact can or cannot be emailed by a campaign. Used for the preview, for launching AND again at send time, so the answer a person
 * sees is the answer the sender applies. null = eligible. Reasons are checked in a fixed order so counts are reproducible.
 */
export async function evaluateContacts(
  tx: Tx,
  organizationId: string,
  campaign: { id: string; min_days_between: number },
  sets: SuppressionSets,
  opts: { contactIds?: string[]; ignoreOwnAttempts?: boolean } = {},
): Promise<Map<string, ExclusionReason | null>> {
  const contacts = await tx.contact.findMany({
    where: { organization_id: organizationId, channel: "email", ...(opts.contactIds ? { id: { in: opts.contactIds } } : {}) },
    select: { id: true, status: true, prospect_id: true },
  });
  const ids = contacts.map((c) => c.id);
  const [consent, prospects, recent, own] = await Promise.all([
    latestConsent(tx, organizationId, ids),
    tx.prospect.findMany({ where: { organization_id: organizationId, id: { in: [...new Set(contacts.map((c) => c.prospect_id))] } } }),
    tx.sendAttempt.findMany({
      where: { organization_id: organizationId, contact_id: { in: ids }, state: "sent", attempted_at: { gte: new Date(Date.now() - campaign.min_days_between * DAY) } },
      select: { contact_id: true },
    }),
    opts.ignoreOwnAttempts ? Promise.resolve([]) : tx.sendAttempt.findMany({ where: { organization_id: organizationId, campaign_id: campaign.id, contact_id: { in: ids } }, select: { contact_id: true } }),
  ]);
  const byProspect = new Map(prospects.map((p) => [p.id, p]));
  const recentSet = new Set(recent.map((r) => r.contact_id));
  const ownSet = new Set(own.map((r) => r.contact_id));
  const result = new Map<string, ExclusionReason | null>();
  for (const c of contacts) {
    const p = byProspect.get(c.prospect_id);
    let reason: ExclusionReason | null = null;
    if (c.status === "opted_out") reason = "opted_out";
    else if (c.status === "bounced") reason = "bounced";
    else if (consent.get(c.id)?.event !== "granted") reason = "no_consent";
    else if (!p || p.status === "disqualified" || prospectDto(p, sets).suppressed) reason = "suppressed";
    else if (ownSet.has(c.id)) reason = "already_in_campaign";
    else if (campaign.min_days_between > 0 && recentSet.has(c.id)) reason = "recently_contacted";
    result.set(c.id, reason);
  }
  return result;
}

/* ---------- unsubscribe link signing ---------- */

const sign = (org: string, contact: string): string => createHmac("sha256", loadSecurityConfig().hmacSecret).update(`unsub:${org}:${contact}`).digest("hex");

export function unsubscribeUrl(org: string, contact: string): string {
  const base = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/unsubscribe?o=${org}&c=${contact}&s=${sign(org, contact)}`;
}

export function validUnsubscribeSignature(org: string, contact: string, sig: string): boolean {
  const a = Buffer.from(sign(org, contact), "hex");
  const b = Buffer.from(sig, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const render = (template: string, vars: Record<string, string>): string => template.replace(/\{\{(company|unsubscribe_url)\}\}/g, (_, k: string) => vars[k] ?? "");

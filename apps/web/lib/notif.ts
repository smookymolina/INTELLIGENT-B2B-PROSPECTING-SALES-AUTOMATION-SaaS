/** Pure helpers for the notification, Claude-usage and cohort screens. */

export const MAX_DESTINATIONS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export const isEmail = (v: string): boolean => v.length <= 254 && EMAIL_RE.test(v);

/** Reads the fixed address fields; blank ones are skipped. Returns null when any is malformed, repeated or there are too many. */
export function parseAddresses(values: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim().toLowerCase();
    if (!v) continue;
    if (!isEmail(v) || out.includes(v)) return null;
    out.push(v);
  }
  return out.length <= MAX_DESTINATIONS ? out : null;
}

/** "12,3 %" (es-MX decimals, one at most). */
export function formatPercent(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "—";
  return `${(Math.round(p * 10) / 10).toLocaleString("es-MX", { maximumFractionDigits: 1 })} %`;
}

/** Bar text: "N de M · X %", or "sin límite" when the limit is 0/null. */
export function usageText(used: number, limit: number | null, percent: number | null): string {
  if (!limit) return `${used.toLocaleString("es-MX")} · sin límite`;
  return `${used.toLocaleString("es-MX")} de ${limit.toLocaleString("es-MX")} · ${formatPercent(percent)}`;
}

/** Micro-dollars (1e-6 USD) to "US$ 1.23". */
export const formatMicros = (micros: number): string => `US$ ${(micros / 1_000_000).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Width for a progress bar, clamped to 0-100. */
export const barValue = (percent: number | null): number => (percent === null || !Number.isFinite(percent) ? 0 : Math.min(100, Math.max(0, Math.round(percent))));

/** Integer 0..max from a form string, or null. */
export function parseCount(v: string, max: number): number | null {
  if (!/^\d{1,9}$/.test(v.trim())) return null;
  const n = Number(v);
  return n <= max ? n : null;
}

export const EVENT_TYPE_LABELS: Record<string, string> = {
  task_overdue: "Tarea vencida",
  task_due_soon: "Tarea por vencer",
  lead_assigned: "Lead asignado",
  opportunity_assigned: "Oportunidad asignada",
  sla_breached: "Plazo (SLA) incumplido",
  draft_pending_review: "Borrador pendiente de revisión",
};

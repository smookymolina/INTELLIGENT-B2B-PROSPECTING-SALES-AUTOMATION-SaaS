import { Inject, Injectable } from "@nestjs/common";
import type { AnalyticsEventDto, AnalyticsEventPageDto, AnalyticsEventsQuery, AnalyticsExportQuery, AnalyticsOverviewDto, AnalyticsQuery } from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { EXPORT_MAX_ROWS, toCsv } from "../http/csv.js";
import { PrismaService, type Tx } from "../db/prisma.service.js";

const DAY = 86_400_000;
const pct = (num: number, den: number): number | null => (den === 0 ? null : Math.round((num / den) * 10_000) / 10_000);

/** Metric definitions are part of the response: a number without its definition is not shown. */
const DEFINITIONS: AnalyticsOverviewDto["definitions"] = [
  { id: "prospects", label: "Prospectos creados", definition: "Prospectos cuyo alta ocurrió dentro de la ventana (manual o importación)." },
  { id: "leads", label: "Leads creados", definition: "Leads (por regla o por respuesta) creados en la ventana, sin importar su revisión posterior." },
  { id: "leads_accepted", label: "Leads aceptados", definition: "Leads creados en la ventana que hoy están aceptados por una persona." },
  { id: "opportunities", label: "Oportunidades creadas", definition: "Oportunidades creadas en la ventana a partir de leads aceptados." },
  { id: "quotes_sent", label: "Cotizaciones enviadas", definition: "Cotizaciones cuyo envío (congelamiento) ocurrió en la ventana, aunque luego se hayan aceptado, rechazado o cancelado." },
  { id: "sales", label: "Ventas", definition: "Cotizaciones aceptadas cuya venta se registró en la ventana." },
  { id: "conversion", label: "Conversión", definition: "Cociente entre los conteos de etapas consecutivas del mismo periodo (no es una cohorte: no sigue a cada registro individual)." },
  { id: "sla", label: "SLA de primera atención", definition: "Oportunidades asignadas en la ventana con un plazo definido; vencido si la primera atención llegó después del plazo, o si el plazo ya pasó sin atención." },
  { id: "win_rate", label: "Tasa de cierre", definition: "Ganadas / (ganadas + perdidas) entre las oportunidades cerradas en la ventana." },
  { id: "reconciliation", label: "Conciliación", definition: "Suma de las ventas del periodo frente a la suma de los totales de las cotizaciones aceptadas que las originaron, por moneda." },
  { id: "window", label: "Ventana", definition: "Días calendario UTC, inclusive en ambos extremos. Todas las cifras respetan el aislamiento por organización." },
];

const FUNNEL_LABELS: Array<[string, string]> = [
  ["prospects", "Prospectos creados"], ["leads", "Leads creados"], ["leads_accepted", "Leads aceptados"], ["opportunities", "Oportunidades creadas"],
  ["quotes_sent", "Cotizaciones enviadas"], ["sales", "Ventas"],
];

export function resolveWindow(q: { from?: string | undefined; to?: string | undefined }, now = new Date()): { from: string; to: string; start: Date; end: Date } {
  const today = now.toISOString().slice(0, 10);
  const to = q.to ?? today;
  const from = q.from ?? new Date(Date.parse(to) - 29 * DAY).toISOString().slice(0, 10);
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(Date.parse(`${to}T00:00:00.000Z`) + DAY); // exclusive upper bound
  return { from, to, start, end };
}

/** Read-only aggregates over the business tables, executed as `app_runtime` so RLS and tenant scoping apply to every number. */
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  overview(auth: AuthContext, q: AnalyticsQuery): Promise<AnalyticsOverviewDto> {
    const w = resolveWindow(q);
    const org = auth.organizationId;
    const range = { gte: w.start, lt: w.end };
    return this.db.withTenant(auth, async (tx) => {
      const [prospects, leadsByOrigin, leadsByState, opportunities, quotesSent, salesGroups, pipeline, transitions, closed, lostReasons, slaRows, reconciliation] = await Promise.all([
        tx.prospect.count({ where: { organization_id: org, created_at: range } }),
        tx.lead.groupBy({ by: ["origin"], where: { organization_id: org, created_at: range }, _count: { _all: true } }),
        tx.lead.groupBy({ by: ["state"], where: { organization_id: org, created_at: range }, _count: { _all: true } }),
        tx.opportunity.count({ where: { organization_id: org, created_at: range } }),
        tx.quote.count({ where: { organization_id: org, sent_at: range } }),
        tx.sale.groupBy({ by: ["currency"], where: { organization_id: org, closed_at: range }, _count: { _all: true }, _sum: { total: true }, _avg: { total: true }, orderBy: { currency: "asc" } }),
        tx.opportunity.groupBy({ by: ["stage"], where: { organization_id: org }, _count: { _all: true } }),
        tx.opportunityStageHistory.groupBy({ by: ["from_stage", "to_stage"], where: { organization_id: org, changed_at: range }, _count: { _all: true } }),
        tx.opportunity.groupBy({ by: ["stage"], where: { organization_id: org, stage: { in: ["won", "lost"] }, closed_at: range }, _count: { _all: true } }),
        tx.opportunity.groupBy({ by: ["loss_reason"], where: { organization_id: org, stage: "lost", closed_at: range }, _count: { _all: true }, orderBy: { _count: { loss_reason: "desc" } }, take: 10 }),
        tx.opportunity.findMany({ where: { organization_id: org, assigned_at: range, first_response_due_at: { not: null } }, select: { assigned_at: true, first_response_due_at: true, first_contacted_at: true } }),
        tx.$queryRaw<Array<{ currency: string; sales_total: string; quotes_total: string }>>`
          SELECT s.currency, sum(s.total)::text AS sales_total, sum(q.total)::text AS quotes_total
          FROM sales s JOIN quotes q ON q.id = s.quote_id AND q.organization_id = s.organization_id
          WHERE s.organization_id = ${org}::uuid AND s.closed_at >= ${w.start} AND s.closed_at < ${w.end}
          GROUP BY s.currency ORDER BY s.currency`,
      ]);
      const accepted = leadsByState.find((g) => g.state === "accepted")?._count._all ?? 0;
      const leadsTotal = leadsByOrigin.reduce((n, g) => n + g._count._all, 0);
      const salesCount = salesGroups.reduce((n, g) => n + g._count._all, 0);
      const counts: Record<string, number> = { prospects, leads: leadsTotal, leads_accepted: accepted, opportunities, quotes_sent: quotesSent, sales: salesCount };
      const funnel = FUNNEL_LABELS.map(([id, label], i) => {
        const previous = i === 0 ? null : (counts[FUNNEL_LABELS[i - 1]?.[0] as string] as number);
        return { id, label, count: counts[id] as number, conversionFromPrevious: previous === null ? null : pct(counts[id] as number, previous) };
      });
      const stages = Object.fromEntries(pipeline.map((g) => [g.stage, g._count._all]));
      const won = closed.find((g) => g.stage === "won")?._count._all ?? 0;
      const lost = closed.find((g) => g.stage === "lost")?._count._all ?? 0;

      const breached = slaRows.filter((r) => (r.first_contacted_at ? r.first_contacted_at > (r.first_response_due_at as Date) : new Date() > (r.first_response_due_at as Date))).length;
      const responded = slaRows.filter((r) => r.first_contacted_at && r.assigned_at);
      const avgMinutes = responded.length
        ? Math.round((responded.reduce((s, r) => s + ((r.first_contacted_at as Date).getTime() - (r.assigned_at as Date).getTime()), 0) / responded.length / 60_000) * 100) / 100
        : null;

      return {
        window: { from: w.from, to: w.to, timezone: "UTC" as const },
        definitions: DEFINITIONS,
        funnel,
        leads: { byOrigin: Object.fromEntries(leadsByOrigin.map((g) => [g.origin, g._count._all])), byState: Object.fromEntries(leadsByState.map((g) => [g.state, g._count._all])) },
        pipeline: { stages, open: pipeline.filter((g) => !["won", "lost", "future"].includes(g.stage)).reduce((n, g) => n + g._count._all, 0) },
        transitions: transitions.map((t) => ({ from: t.from_stage, to: t.to_stage, count: t._count._all })).sort((a, b) => b.count - a.count || a.to.localeCompare(b.to)),
        sla: { measured: slaRows.length, breached, breachRate: pct(breached, slaRows.length), avgFirstResponseMinutes: avgMinutes },
        outcomes: { won, lost, winRate: pct(won, won + lost), lostReasons: lostReasons.filter((r) => r.loss_reason).map((r) => ({ reason: r.loss_reason as string, count: r._count._all })) },
        sales: salesGroups.map((g) => ({ currency: g.currency, count: g._count._all, total: (g._sum.total as { toFixed(n: number): string }).toFixed(4), average: (g._avg.total as { toFixed(n: number): string }).toFixed(4) })),
        reconciliation: reconciliation.map((r) => ({ currency: r.currency, salesTotal: r.sales_total, quotesTotal: r.quotes_total, matches: r.sales_total === r.quotes_total })),
      };
    });
  }

  /** CSV of the records behind one metric. Capped, formula-safe, and the export itself is audited (who took how many rows of what). */
  exportEvents(auth: AuthContext, q: AnalyticsExportQuery): Promise<{ csv: string; truncated: boolean }> {
    const w = resolveWindow(q);
    return this.db.withTenant(auth, async (tx) => {
      const rows = await this.rows(tx, auth, q.metric, w, undefined, EXPORT_MAX_ROWS + 1);
      const truncated = rows.length > EXPORT_MAX_ROWS;
      const kept = rows.slice(0, EXPORT_MAX_ROWS);
      await this.audit.record(tx, auth, { action: "export.created", resourceType: "analytics", metadata: { metric: q.metric, from: w.from, to: w.to, rows: kept.length, truncated } });
      return { csv: toCsv(["id", "at", "type", "title"], kept.map((e) => [e.id, e.at, e.type, e.title])), truncated };
    });
  }

  /** Drill-down: the records behind each count (same window and filters as the overview). */
  events(auth: AuthContext, q: AnalyticsEventsQuery): Promise<AnalyticsEventPageDto> {
    const w = resolveWindow(q);
    return this.db.withTenant(auth, async (tx) => {
      const rows = await this.rows(tx, auth, q.metric, w, q.cursor, q.limit + 1);
      const page = rows.slice(0, q.limit);
      return { items: page, nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
    });
  }

  private async rows(tx: Tx, auth: AuthContext, metric: AnalyticsEventsQuery["metric"], w: { start: Date; end: Date }, cursor: string | undefined, take: number): Promise<AnalyticsEventDto[]> {
    const org = auth.organizationId;
    const range = { gte: w.start, lt: w.end };
    const after = cursor ? { id: { gt: cursor } } : {};
    const iso = (d: Date) => d.toISOString();
    switch (metric) {
      case "prospects_created":
        return (await tx.prospect.findMany({ where: { organization_id: org, created_at: range, ...after }, orderBy: { id: "asc" }, take })).map((r) => ({ id: r.id, type: "prospect", at: iso(r.created_at), title: r.name, path: `/prospects/${r.id}` }));
      case "leads_created":
        return (await tx.lead.findMany({ where: { organization_id: org, created_at: range, ...after }, orderBy: { id: "asc" }, take })).map((r) => ({ id: r.id, type: `lead:${r.origin}:${r.state}`, at: iso(r.created_at), title: `Lead (${r.origin})`, path: "/leads" }));
      case "opportunities_created":
        return (await tx.opportunity.findMany({ where: { organization_id: org, created_at: range, ...after }, orderBy: { id: "asc" }, take })).map((r) => ({ id: r.id, type: "opportunity", at: iso(r.created_at), title: r.title, path: `/pipeline/${r.id}` }));
      case "quotes_sent":
        return (await tx.quote.findMany({ where: { organization_id: org, sent_at: range, ...after }, orderBy: { id: "asc" }, take })).map((r) => ({ id: r.id, type: `quote:${r.status}`, at: iso(r.sent_at as Date), title: `Cotización Q-${String(r.number).padStart(4, "0")}`, path: `/quotes/${r.id}` }));
      case "sales_closed":
        return (await tx.sale.findMany({ where: { organization_id: org, closed_at: range, ...after }, orderBy: { id: "asc" }, take, include: { quote: { select: { number: true } } } })).map((r) => ({ id: r.id, type: "sale", at: iso(r.closed_at), title: `Venta Q-${String(r.quote.number).padStart(4, "0")} · ${r.total.toFixed(4)} ${r.currency}`, path: `/quotes/${r.quote_id}` }));
      case "opportunities_lost":
        return (await tx.opportunity.findMany({ where: { organization_id: org, stage: "lost", closed_at: range, ...after }, orderBy: { id: "asc" }, take })).map((r) => ({ id: r.id, type: "opportunity:lost", at: iso(r.closed_at as Date), title: `${r.title} — ${r.loss_reason ?? ""}`, path: `/pipeline/${r.id}` }));
    }
  }
}

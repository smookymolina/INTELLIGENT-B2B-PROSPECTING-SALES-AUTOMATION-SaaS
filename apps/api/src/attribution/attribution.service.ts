import { Inject, Injectable } from "@nestjs/common";
import type { AttributionQuery, AttributionReportDto, CohortsQuery, CohortsReportDto } from "@prospecting/contracts";
import { resolveWindow } from "../analytics/analytics.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService } from "../db/prisma.service.js";

const MODEL_DEFINITION =
  "Ultimo toque: cada lead, oportunidad y venta de la ventana se atribuye a la campana cuyo correo (envio con estado 'sent') llego a cualquier contacto del mismo prospecto " +
  "con el toque mas reciente dentro de los N dias (lookbackDays) anteriores a la conversion e inclusive hasta ella. Anclas: lead = su creacion; oportunidad = su creacion; " +
  "venta = la creacion de la oportunidad que la origino (asi un lead, su oportunidad y su venta caen en la misma campana). Sin toque en la ventana = 'sin atribuir'. " +
  "Las ventanas de conversion son las de la analitica (leads/oportunidades por creacion, ventas por cierre), por lo que atribuido + sin atribuir = total de analitica.";

const COHORT_DEFINITION =
  "Cohorte = mes UTC de alta del prospecto (solo prospectos dados de alta dentro de la ventana). Para cada cohorte: 'ever' cuenta prospectos con al menos un lead / oportunidad / venta " +
  "(la primera de cada tipo), y within30d/60d/90d solo los que la lograron dentro de esos dias desde el alta del prospecto. La suma de tamanos de cohorte = prospectos creados en analitica.";

type Money = { currency: string; count: number; total: string };
type Row = { campaign_id: string | null; n: number };
type SaleRow = { campaign_id: string | null; currency: string; n: number; total: string };

function addMoney(rows: SaleRow[], key: string | null): Money[] {
  return rows.filter((r) => r.campaign_id === key).map((r) => ({ currency: r.currency, count: r.n, total: r.total })).sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Read-only attribution/cohort queries executed as `app_runtime` (RLS on every table) and additionally scoped by organization_id. */
@Injectable()
export class AttributionService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  campaigns(auth: AuthContext, q: AttributionQuery): Promise<AttributionReportDto> {
    const w = resolveWindow(q);
    const org = auth.organizationId;
    const days = q.lookbackDays;
    return this.db.withTenant(auth, async (tx) => {
      // Last sent email, for any contact of the prospect, in [anchor - days, anchor]. Ties broken by id for determinism.
      const [leads, opps, sales, sent, campaigns] = await Promise.all([
        tx.$queryRaw<Row[]>`
          SELECT t.campaign_id::text AS campaign_id, count(*)::int AS n
          FROM leads l LEFT JOIN LATERAL (
            SELECT sa.campaign_id FROM send_attempts sa JOIN contacts c ON c.id = sa.contact_id AND c.organization_id = sa.organization_id
            WHERE sa.organization_id = l.organization_id AND c.prospect_id = l.prospect_id AND sa.state = 'sent'
              AND sa.attempted_at <= l.created_at AND sa.attempted_at >= l.created_at - make_interval(days => ${days}::int)
            ORDER BY sa.attempted_at DESC, sa.id DESC LIMIT 1) t ON true
          WHERE l.organization_id = ${org}::uuid AND l.created_at >= ${w.start} AND l.created_at < ${w.end}
          GROUP BY t.campaign_id`,
        tx.$queryRaw<Row[]>`
          SELECT t.campaign_id::text AS campaign_id, count(*)::int AS n
          FROM opportunities o LEFT JOIN LATERAL (
            SELECT sa.campaign_id FROM send_attempts sa JOIN contacts c ON c.id = sa.contact_id AND c.organization_id = sa.organization_id
            WHERE sa.organization_id = o.organization_id AND c.prospect_id = o.prospect_id AND sa.state = 'sent'
              AND sa.attempted_at <= o.created_at AND sa.attempted_at >= o.created_at - make_interval(days => ${days}::int)
            ORDER BY sa.attempted_at DESC, sa.id DESC LIMIT 1) t ON true
          WHERE o.organization_id = ${org}::uuid AND o.created_at >= ${w.start} AND o.created_at < ${w.end}
          GROUP BY t.campaign_id`,
        tx.$queryRaw<SaleRow[]>`
          SELECT t.campaign_id::text AS campaign_id, s.currency, count(*)::int AS n, sum(s.total)::text AS total
          FROM sales s JOIN opportunities o ON o.id = s.opportunity_id AND o.organization_id = s.organization_id
          LEFT JOIN LATERAL (
            SELECT sa.campaign_id FROM send_attempts sa JOIN contacts c ON c.id = sa.contact_id AND c.organization_id = sa.organization_id
            WHERE sa.organization_id = s.organization_id AND c.prospect_id = s.prospect_id AND sa.state = 'sent'
              AND sa.attempted_at <= o.created_at AND sa.attempted_at >= o.created_at - make_interval(days => ${days}::int)
            ORDER BY sa.attempted_at DESC, sa.id DESC LIMIT 1) t ON true
          WHERE s.organization_id = ${org}::uuid AND s.closed_at >= ${w.start} AND s.closed_at < ${w.end}
          GROUP BY t.campaign_id, s.currency`,
        tx.$queryRaw<Array<{ campaign_id: string; sent: number; reached: number }>>`
          SELECT sa.campaign_id::text AS campaign_id, count(*)::int AS sent, count(DISTINCT c.prospect_id)::int AS reached
          FROM send_attempts sa JOIN contacts c ON c.id = sa.contact_id AND c.organization_id = sa.organization_id
          WHERE sa.organization_id = ${org}::uuid AND sa.state = 'sent' AND sa.attempted_at >= ${w.start} AND sa.attempted_at < ${w.end}
          GROUP BY sa.campaign_id`,
        tx.campaign.findMany({ where: { organization_id: org }, select: { id: true, name: true } }),
      ]);
      const names = new Map(campaigns.map((c) => [c.id, c.name]));
      const ids = new Set<string>();
      for (const r of [...leads, ...opps, ...sales, ...sent]) if (r.campaign_id) ids.add(r.campaign_id);
      const count = (rows: Row[], k: string | null) => rows.find((r) => r.campaign_id === k)?.n ?? 0;
      const salesCount = (k: string | null) => sales.filter((r) => r.campaign_id === k).reduce((n, r) => n + r.n, 0);
      const rows = [...ids].map((id) => {
        const s = sent.find((x) => x.campaign_id === id);
        return {
          campaignId: id, name: names.get(id) ?? id, sent: s?.sent ?? 0, prospectsReached: s?.reached ?? 0,
          leads: count(leads, id), opportunities: count(opps, id), sales: salesCount(id), salesByCurrency: addMoney(sales, id),
        };
      }).sort((a, b) => b.sales - a.sales || b.opportunities - a.opportunities || b.leads - a.leads || a.name.localeCompare(b.name));
      const totalMoney = new Map<string, { count: number; total: bigint }>();
      for (const r of sales) {
        const [i = "0", f = ""] = r.total.split(".");
        const scaled = BigInt(i) * 10_000n + BigInt((f + "0000").slice(0, 4)) * (i.startsWith("-") ? -1n : 1n);
        const cur = totalMoney.get(r.currency) ?? { count: 0, total: 0n };
        totalMoney.set(r.currency, { count: cur.count + r.n, total: cur.total + scaled });
      }
      const fmt = (v: bigint) => `${v / 10_000n}.${String(v % 10_000n).padStart(4, "0")}`;
      return {
        window: { from: w.from, to: w.to, timezone: "UTC" as const },
        model: { id: "last_touch_sent_email" as const, lookbackDays: days, definition: MODEL_DEFINITION },
        campaigns: rows,
        unattributed: { leads: count(leads, null), opportunities: count(opps, null), sales: salesCount(null), salesByCurrency: addMoney(sales, null) },
        totals: {
          leads: leads.reduce((n, r) => n + r.n, 0), opportunities: opps.reduce((n, r) => n + r.n, 0), sales: sales.reduce((n, r) => n + r.n, 0),
          salesByCurrency: [...totalMoney.entries()].map(([currency, v]) => ({ currency, count: v.count, total: fmt(v.total) })).sort((a, b) => a.currency.localeCompare(b.currency)),
        },
      };
    });
  }

  cohorts(auth: AuthContext, q: CohortsQuery): Promise<CohortsReportDto> {
    const w = resolveWindow(q);
    const org = auth.organizationId;
    return this.db.withTenant(auth, async (tx) => {
      type R = Record<string, number | string>;
      const rows = await tx.$queryRaw<R[]>`
        WITH f AS (
          SELECT p.id, p.created_at,
            (SELECT min(l.created_at) FROM leads l WHERE l.organization_id = p.organization_id AND l.prospect_id = p.id) AS lead_at,
            (SELECT min(o.created_at) FROM opportunities o WHERE o.organization_id = p.organization_id AND o.prospect_id = p.id) AS opp_at,
            (SELECT min(s.closed_at) FROM sales s WHERE s.organization_id = p.organization_id AND s.prospect_id = p.id) AS sale_at
          FROM prospects p WHERE p.organization_id = ${org}::uuid AND p.created_at >= ${w.start} AND p.created_at < ${w.end})
        SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month, count(*)::int AS prospects,
          count(lead_at)::int AS l_ever, (count(*) FILTER (WHERE lead_at <= created_at + interval '30 days'))::int AS l30, (count(*) FILTER (WHERE lead_at <= created_at + interval '60 days'))::int AS l60, (count(*) FILTER (WHERE lead_at <= created_at + interval '90 days'))::int AS l90,
          count(opp_at)::int AS o_ever, (count(*) FILTER (WHERE opp_at <= created_at + interval '30 days'))::int AS o30, (count(*) FILTER (WHERE opp_at <= created_at + interval '60 days'))::int AS o60, (count(*) FILTER (WHERE opp_at <= created_at + interval '90 days'))::int AS o90,
          count(sale_at)::int AS s_ever, (count(*) FILTER (WHERE sale_at <= created_at + interval '30 days'))::int AS s30, (count(*) FILTER (WHERE sale_at <= created_at + interval '60 days'))::int AS s60, (count(*) FILTER (WHERE sale_at <= created_at + interval '90 days'))::int AS s90
        FROM f GROUP BY 1 ORDER BY 1`;
      const step = (r: R, p: string) => ({ ever: r[`${p}_ever`] as number, within30d: r[`${p}30`] as number, within60d: r[`${p}60`] as number, within90d: r[`${p}90`] as number });
      const cohorts = rows.map((r) => ({ month: r.month as string, prospects: r.prospects as number, leads: step(r, "l"), opportunities: step(r, "o"), sales: step(r, "s") }));
      return {
        window: { from: w.from, to: w.to, timezone: "UTC" as const },
        definition: COHORT_DEFINITION,
        cohorts,
        totalProspects: cohorts.reduce((n, c) => n + c.prospects, 0),
      };
    });
  }
}

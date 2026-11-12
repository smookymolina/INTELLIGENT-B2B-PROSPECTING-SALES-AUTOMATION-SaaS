import Link from "next/link";
import type { AnalyticsOverviewDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { STAGE_LABELS } from "../../../lib/format";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DRILL: Record<string, string> = { prospects: "prospects_created", leads: "leads_created", opportunities: "opportunities_created", quotes_sent: "quotes_sent", sales: "sales_closed" };
const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)} %`);

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  if (!me.permissions.includes("analytics:read")) return <p role="alert" className="notice error">Tu rol no tiene acceso a la analítica (los vendedores trabajan desde el pipeline).</p>;
  const query = new URLSearchParams();
  if (sp.from && DATE.test(sp.from)) query.set("from", sp.from);
  if (sp.to && DATE.test(sp.to)) query.set("to", sp.to);
  let result = await api<AnalyticsOverviewDto>(`/analytics/overview?${query}`, { token });
  let invalid = false;
  if (!result.ok && result.status === 400) {
    invalid = true;
    result = await api<AnalyticsOverviewDto>("/analytics/overview", { token }); // fall back to the default window
  }
  if (!result.ok) throw new Error("Analytics could not be loaded");
  const o = result.data;
  const max = Math.max(1, ...o.funnel.map((f) => f.count));
  const range = `from=${o.window.from}&to=${o.window.to}`;
  return (
    <>
      <header className="page-head">
        <h1>Analítica</h1>
      </header>
      {invalid ? <p role="alert" className="notice error">La ventana indicada no es válida (máximo 366 días, «desde» no puede ser posterior a «hasta»). Se muestra la ventana por defecto.</p> : null}
      <form method="get" className="filters" aria-label="Ventana">
        <label>Desde (UTC)<input name="from" type="date" defaultValue={o.window.from} /></label>
        <label>Hasta (UTC)<input name="to" type="date" defaultValue={o.window.to} /></label>
        <button type="submit">Aplicar</button>
      </form>
      <p className="hint">Ventana {o.window.from} → {o.window.to} ({o.window.timezone}, días completos). Las cifras salen de los registros de negocio y respetan el aislamiento de tu organización.</p>
      <details>
        <summary>Definiciones de las métricas</summary>
        <dl>{o.definitions.map((d) => <div key={d.id} className="row"><dt>{d.label}</dt><dd>{d.definition}</dd></div>)}</dl>
      </details>

      <h2>Embudo</h2>
      <div className="table-wrap">
        <table>
          <caption className="sr">Embudo del periodo</caption>
          <thead><tr><th scope="col">Etapa</th><th scope="col">Cantidad</th><th scope="col">Conversión vs. etapa anterior</th><th scope="col">Detalle</th></tr></thead>
          <tbody>
            {o.funnel.map((f) => (
              <tr key={f.id}>
                <th scope="row">{f.label}</th>
                <td><span className="funnel-bar" style={{ width: `${Math.round((f.count / max) * 100)}%` }} aria-hidden="true" /> {f.count}</td>
                <td>{pct(f.conversionFromPrevious)}</td>
                <td>{DRILL[f.id] ? <Link href={`/analytics/events?metric=${DRILL[f.id]}&${range}`}>ver registros</Link> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Resultados</h2>
      <dl className="stats">
        <div><dt>Ganadas</dt><dd>{o.outcomes.won}</dd></div>
        <div><dt>Perdidas</dt><dd>{o.outcomes.lost}</dd></div>
        <div><dt>Tasa de cierre</dt><dd>{pct(o.outcomes.winRate)}</dd></div>
        <div><dt>SLA medido</dt><dd>{o.sla.measured}</dd></div>
        <div><dt>SLA vencido</dt><dd>{o.sla.breached} ({pct(o.sla.breachRate)})</dd></div>
        <div><dt>1ª atención (prom.)</dt><dd>{o.sla.avgFirstResponseMinutes === null ? "—" : `${o.sla.avgFirstResponseMinutes} min`}</dd></div>
      </dl>
      {o.outcomes.lostReasons.length ? <p>Motivos de pérdida: {o.outcomes.lostReasons.map((r) => `${r.reason} (${r.count})`).join(", ")} · <Link href={`/analytics/events?metric=opportunities_lost&${range}`}>ver registros</Link></p> : null}

      <h2>Ventas y conciliación</h2>
      {o.sales.length === 0 ? <p className="empty">Sin ventas en la ventana.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Ventas por moneda</caption>
            <thead><tr><th scope="col">Moneda</th><th scope="col">Ventas</th><th scope="col">Total</th><th scope="col">Promedio</th><th scope="col">Conciliación con cotizaciones aceptadas</th></tr></thead>
            <tbody>
              {o.sales.map((s) => {
                const rec = o.reconciliation.find((r) => r.currency === s.currency);
                return <tr key={s.currency}><td>{s.currency}</td><td>{s.count}</td><td>{s.total}</td><td>{s.average}</td><td>{rec ? (rec.matches ? `Coincide (${rec.quotesTotal})` : `NO coincide: ventas ${rec.salesTotal} vs. cotizaciones ${rec.quotesTotal}`) : "—"}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2>Pipeline actual</h2>
      <p>{o.pipeline.open} oportunidades abiertas. {Object.entries(o.pipeline.stages).map(([s, n]) => `${STAGE_LABELS[s] ?? s}: ${n}`).join(" · ") || "Sin oportunidades."}</p>
      <h2>Cambios de etapa en la ventana</h2>
      {o.transitions.length === 0 ? <p className="empty">Sin cambios.</p> : (
        <ul>{o.transitions.map((t, i) => <li key={i}>{t.from ? STAGE_LABELS[t.from] : "creación"} → {STAGE_LABELS[t.to]}: <strong>{t.count}</strong></li>)}</ul>
      )}
      <p className="hint">Leads por origen: {Object.entries(o.leads.byOrigin).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"} · por estado: {Object.entries(o.leads.byState).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}.</p>
    </>
  );
}

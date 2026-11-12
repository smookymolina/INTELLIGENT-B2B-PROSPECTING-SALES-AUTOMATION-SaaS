import Link from "next/link";
import { ANALYTICS_EVENT_METRICS, type AnalyticsEventPageDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { formatDate, pick } from "../../../../lib/format";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TITLES: Record<string, string> = {
  prospects_created: "Prospectos creados", leads_created: "Leads creados", opportunities_created: "Oportunidades creadas", quotes_sent: "Cotizaciones enviadas",
  sales_closed: "Ventas", opportunities_lost: "Oportunidades perdidas",
};

export default async function AnalyticsEventsPage({ searchParams }: { searchParams: Promise<{ metric?: string; from?: string; to?: string; cursor?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  if (!me.permissions.includes("analytics:read")) return <><h1>Registros de analítica</h1><p role="alert" className="notice error">Tu rol no tiene acceso a la analítica.</p></>;
  const metric = pick(sp.metric, ANALYTICS_EVENT_METRICS);
  if (!metric) return <><h1>Registros de analítica</h1><p role="alert" className="notice error">Métrica desconocida. <Link href="/analytics">Volver</Link></p></>;
  const query = new URLSearchParams({ metric, limit: "50" });
  if (sp.from && DATE.test(sp.from)) query.set("from", sp.from);
  if (sp.to && DATE.test(sp.to)) query.set("to", sp.to);
  if (sp.cursor && /^[0-9a-f-]{36}$/i.test(sp.cursor)) query.set("cursor", sp.cursor);
  const result = await api<AnalyticsEventPageDto>(`/analytics/events?${query}`, { token });
  if (!result.ok) throw new Error("The records could not be loaded");
  const next = new URLSearchParams({ metric, ...(sp.from && DATE.test(sp.from) ? { from: sp.from } : {}), ...(sp.to && DATE.test(sp.to) ? { to: sp.to } : {}), cursor: result.data.nextCursor ?? "" });
  return (
    <>
      <p><Link href="/analytics">← Analítica</Link></p>
      <header className="page-head">
        <h1>{TITLES[metric]}</h1>
      </header>
      <p className="hint">Los registros de negocio detrás de la cifra, con la misma ventana y los mismos filtros.</p>
      <p><a href={`/export/analytics?${new URLSearchParams({ metric, ...(sp.from && DATE.test(sp.from) ? { from: sp.from } : {}), ...(sp.to && DATE.test(sp.to) ? { to: sp.to } : {}) })}`} download>Exportar CSV (hasta 10 000 filas; queda registrado en auditoría)</a></p>
      {result.data.items.length === 0 ? <p className="empty">Sin registros.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Registros</caption>
            <thead><tr><th scope="col">Fecha</th><th scope="col">Tipo</th><th scope="col">Registro</th></tr></thead>
            <tbody>{result.data.items.map((e) => <tr key={e.id}><td>{formatDate(e.at)}</td><td><code>{e.type}</code></td><td>{e.path ? <Link href={e.path}>{e.title}</Link> : e.title}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {result.data.nextCursor ? <p><Link href={`/analytics/events?${next}`}>Siguiente página →</Link></p> : null}
    </>
  );
}

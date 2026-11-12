import Link from "next/link";
import type { QuotePageDto, QuoteSettingsDto, SalePageDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { formatDate } from "../../../lib/format";
import { Flash } from "../../components/flash";

const STATUS: Record<string, string> = { draft: "Borrador", sent: "Enviada", accepted: "Aceptada", rejected: "Rechazada", cancelled: "Cancelada" };

export default async function SalesPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  const can = (p: string) => (me.permissions as readonly string[]).includes(p);
  if (!can("quotes:read")) return <p role="alert" className="notice error">Tu rol no tiene acceso a cotizaciones ni ventas.</p>;
  const [quotes, sales, settings] = await Promise.all([api<QuotePageDto>("/quotes?limit=50", { token }), api<SalePageDto>("/sales?limit=50", { token }), api<QuoteSettingsDto>("/quotes/settings", { token })]);
  if (!quotes.ok || !sales.ok || !settings.ok) throw new Error("Quotes could not be loaded");
  return (
    <>
      <header className="page-head">
        <h1>Cotizaciones y ventas</h1>
      </header>
      <Flash sp={sp} />
      <p className="hint">Las cotizaciones se arman con productos y precios aprobados, con totales exactos; al enviarlas quedan congeladas. Una cotización aceptada registra la venta y gana la oportunidad.</p>
      <p>Descuento máximo sin aprobación: <strong>{settings.data.maxDiscountPercent} %</strong> (por defecto 0: todo descuento necesita aprobación de un administrador).</p>
      {can("quotes:approve") ? (
        <form method="post" action="/actions/quotes/settings" className="inline">
          <label>Límite de descuento sin aprobación (%)<input name="maxDiscountPercent" required inputMode="decimal" pattern="[0-9]{1,3}(\.[0-9]{1,2})?" defaultValue={settings.data.maxDiscountPercent} /></label>
          <button type="submit" className="secondary">Guardar límite</button>
        </form>
      ) : null}
      <h2>Cotizaciones</h2>
      {quotes.data.items.length === 0 ? <p className="empty">Aún no hay cotizaciones. Se crean desde una <Link href="/pipeline">oportunidad</Link>.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Cotizaciones</caption>
            <thead><tr><th scope="col">Número</th><th scope="col">Estado</th><th scope="col">Total</th><th scope="col">Creada</th></tr></thead>
            <tbody>{quotes.data.items.map((q) => <tr key={q.id}><td><Link href={`/quotes/${q.id}`}>{q.label}</Link></td><td>{STATUS[q.status]}</td><td>{q.total} {q.currency}</td><td>{formatDate(q.createdAt)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      <h2>Ventas</h2>
      {sales.data.items.length === 0 ? <p className="empty">Sin ventas registradas.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Ventas</caption>
            <thead><tr><th scope="col">Cotización</th><th scope="col">Total</th><th scope="col">Cierre</th><th scope="col">Oportunidad</th></tr></thead>
            <tbody>{sales.data.items.map((s) => <tr key={s.id}><td><Link href={`/quotes/${s.quoteId}`}>Q-{String(s.quoteNumber).padStart(4, "0")}</Link></td><td>{s.total} {s.currency}</td><td>{formatDate(s.closedAt)}</td><td><Link href={`/pipeline/${s.opportunityId}`}>ver</Link></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

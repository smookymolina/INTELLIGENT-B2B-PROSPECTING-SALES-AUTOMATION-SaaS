import Link from "next/link";
import type { PriceListPageDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { STATUS_LABELS, label, pick } from "../../../lib/format";
import { Flash } from "../../components/flash";

const STATUSES = ["all", "draft", "approved", "archived"] as const;

export default async function PricingPage({ searchParams }: { searchParams: Promise<{ status?: string; cursor?: string; ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const raw = await searchParams;
  const status = pick(raw.status, STATUSES) ?? "all";
  const query = new URLSearchParams({ status, limit: "25" });
  if (raw.cursor && /^[0-9a-f-]{36}$/i.test(raw.cursor)) query.set("cursor", raw.cursor);
  const result = await api<PriceListPageDto>(`/catalog/price-lists?${query}`, { token });
  if (!result.ok) throw new Error("Price lists could not be loaded");
  const { items, nextCursor } = result.data;
  return (
    <>
      <h1>Listas de precios</h1>
      <Flash sp={raw} />
      <p className="hint">Una lista aprobada es inmutable; para cambiarla se clona. Sólo los precios de listas aprobadas con productos aprobados pueden usarse en cotizaciones o por la IA.</p>
      <p className="toolbar">{me.permissions.includes("catalog:manage") ? <Link href="/pricing/new">+ Nueva lista</Link> : null}</p>
      <form method="get" className="filters" aria-label="Filtros">
        <label>Estado<select name="status" defaultValue={status}>{STATUSES.map((s) => <option key={s} value={s}>{s === "all" ? "Todos" : label(STATUS_LABELS, s)}</option>)}</select></label>
        <button type="submit">Filtrar</button>
      </form>
      {items.length === 0 ? <p className="empty">Aún no hay listas de precios. Nada se prellena: los precios los define tu organización.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Listas de precios</caption>
            <thead><tr><th scope="col">Nombre</th><th scope="col">Moneda</th><th scope="col">Estado</th><th scope="col">Precios</th><th scope="col">Vigencia</th></tr></thead>
            <tbody>
              {items.map((l) => (
                <tr key={l.id}>
                  <td><Link href={`/pricing/${l.id}`}>{l.name}</Link></td><td>{l.currency}</td>
                  <td><span className={`badge ${l.status}`}>{label(STATUS_LABELS, l.status)}</span></td>
                  <td>{l.entryCount}</td><td>{l.validFrom ?? "—"} → {l.validUntil ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor ? <p><Link href={`/pricing?status=${status}&cursor=${nextCursor}`}>Siguiente página →</Link></p> : null}
    </>
  );
}

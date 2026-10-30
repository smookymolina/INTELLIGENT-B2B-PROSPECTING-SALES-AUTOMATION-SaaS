import Link from "next/link";
import { notFound } from "next/navigation";
import type { QuoteDetailDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { formatDate } from "../../../../lib/format";
import { Flash } from "../../../components/flash";

const STATUS: Record<string, string> = { draft: "Borrador", sent: "Enviada (congelada)", accepted: "Aceptada", rejected: "Rechazada", cancelled: "Cancelada" };

export default async function QuotePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const result = await api<QuoteDetailDto>(`/quotes/${id}`, { token });
  if (!result.ok && (result.status === 404 || result.status === 400)) notFound();
  if (!result.ok) throw new Error("The quote could not be loaded");
  const q = result.data;
  const can = (p: string) => (me.permissions as readonly string[]).includes(p);
  const draft = q.status === "draft";
  return (
    <>
      <p><Link href={`/pipeline/${q.opportunityId}`}>← Oportunidad</Link></p>
      <h1>Cotización {q.label} <span className={`badge ${q.status === "accepted" ? "approved" : q.status === "draft" ? "draft" : "archived"}`}>{STATUS[q.status]}</span></h1>
      <Flash sp={sp} />
      <p>Moneda <strong>{q.currency}</strong> · vigente hasta {q.validUntil ?? "sin fecha"} · impuesto {q.taxRate ? `${q.taxRate} %` : "ninguno"}{q.sentAt ? ` · enviada ${formatDate(q.sentAt)}` : ""}</p>
      {q.notes ? <p className="hint">Condiciones: {q.notes}</p> : null}
      {draft && q.requiresDiscountApproval ? <p role="alert" className="notice error">{q.discountApproved ? "Descuentos aprobados." : "Hay descuentos sobre el límite: un administrador debe aprobarlos antes de enviar."}</p> : null}

      <div className="table-wrap">
        <table>
          <caption className="sr">Líneas</caption>
          <thead><tr><th scope="col">SKU</th><th scope="col">Descripción</th><th scope="col">Cant.</th><th scope="col">Precio</th><th scope="col">Desc. %</th><th scope="col">Importe</th><th scope="col">Evidencia</th>{draft && can("quotes:manage") ? <th scope="col" /> : null}</tr></thead>
          <tbody>
            {q.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.sku}</td><td>{l.itemName} <span className="hint">v{l.itemVersion}</span></td><td>{l.quantity}</td><td>{l.unitPrice}</td><td>{l.discountPercent}</td><td>{l.lineTotal}</td>
                <td><code>{l.itemRef.slice(0, 14)}…</code></td>
                {draft && can("quotes:manage") ? <td><form method="post" action={`/actions/quotes/${q.id}/unline`} className="inline-form"><input type="hidden" name="lineId" value={l.id} /><button type="submit" className="secondary">Quitar</button></form></td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="stats">
        <div><dt>Subtotal</dt><dd>{q.subtotal}</dd></div>
        <div><dt>Descuentos</dt><dd>{q.discountTotal}</dd></div>
        <div><dt>Impuesto</dt><dd>{q.taxTotal}</dd></div>
        <div><dt>Total {q.currency}</dt><dd>{q.total}</dd></div>
      </dl>

      {draft && can("quotes:manage") ? (
        <>
          <h2>Agregar producto</h2>
          <p className="hint">El precio y la versión salen del catálogo aprobado y de la lista de precios de esta cotización; no se escriben a mano. Si no hay evidencia aprobada, no se puede agregar.</p>
          <form method="post" action={`/actions/quotes/${q.id}/line`} className="inline">
            <label>SKU<input name="sku" required maxLength={64} /></label>
            <label>Cantidad<input name="quantity" required inputMode="decimal" pattern="[0-9]{1,10}(\.[0-9]{1,4})?" /></label>
            <label>Descuento % (opcional)<input name="discountPercent" inputMode="decimal" pattern="[0-9]{1,3}(\.[0-9]{1,2})?" /></label>
            <button type="submit">Agregar</button>
          </form>
          <h2>Condiciones</h2>
          <form method="post" action={`/actions/quotes/${q.id}/update`}>
            <label>Vigente hasta<input name="validUntil" type="date" defaultValue={q.validUntil ?? ""} /></label>
            <label>Impuesto (%)<input name="taxRate" inputMode="decimal" pattern="[0-9]{1,3}(\.[0-9]{1,4})?" defaultValue={q.taxRate ?? ""} /></label>
            <label>Condiciones comerciales<textarea name="notes" rows={3} maxLength={1000} defaultValue={q.notes ?? ""} /></label>
            <button type="submit">Guardar</button>
          </form>
          <div className="actions" role="group" aria-label="Acciones">
            {can("quotes:approve") && q.requiresDiscountApproval ? <form method="post" action={`/actions/quotes/${q.id}/approve-discount`} className="inline-form"><button type="submit" className="secondary">Aprobar descuentos</button></form> : null}
            <form method="post" action={`/actions/quotes/${q.id}/send`} className="inline-form"><button type="submit">Enviar (congela la cotización)</button></form>
            <form method="post" action={`/actions/quotes/${q.id}/decision`} className="inline-form"><button type="submit" name="decision" value="cancel" className="secondary">Cancelar</button></form>
          </div>
        </>
      ) : null}
      {q.status === "sent" && can("quotes:manage") ? (
        <form method="post" action={`/actions/quotes/${q.id}/decision`} className="inline">
          <label>Nota (opcional)<input name="note" maxLength={300} /></label>
          <button type="submit" name="decision" value="accept">Registrar aceptación</button>
          <button type="submit" name="decision" value="reject" className="secondary">Registrar rechazo</button>
          <button type="submit" name="decision" value="cancel" className="secondary">Cancelar</button>
        </form>
      ) : null}
    </>
  );
}

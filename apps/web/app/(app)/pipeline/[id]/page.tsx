import Link from "next/link";
import { notFound } from "next/navigation";
import { OPPORTUNITY_TRANSITIONS, type OpportunityDetailDto, type PoolDto, type PriceListPageDto, type QuotePageDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { STAGE_LABELS, formatDate } from "../../../../lib/format";
import { Flash } from "../../../components/flash";

const QUOTE_LABELS: Record<string, string> = { draft: "Borrador", sent: "Enviada", accepted: "Aceptada", rejected: "Rechazada", cancelled: "Cancelada" };

export default async function OpportunityPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const result = await api<OpportunityDetailDto>(`/opportunities/${id}`, { token });
  if (!result.ok && (result.status === 404 || result.status === 400)) notFound();
  if (!result.ok) throw new Error("The opportunity could not be loaded");
  const o = result.data;
  const can = (p: string) => (me.permissions as readonly string[]).includes(p);
  const closed = o.stage === "won" || o.stage === "lost";
  const next = OPPORTUNITY_TRANSITIONS[o.stage];
  const [pool, lists, quotes] = await Promise.all([
    can("crm:manage") ? api<PoolDto>("/routing/pool", { token }) : Promise.resolve(null),
    can("quotes:manage") && !closed ? api<PriceListPageDto>("/catalog/price-lists?status=approved&limit=100", { token }) : Promise.resolve(null),
    can("quotes:read") ? api<QuotePageDto>(`/quotes?opportunityId=${id}&limit=50`, { token }) : Promise.resolve(null),
  ]);
  return (
    <>
      <p><Link href="/pipeline">← Pipeline</Link></p>
      <h1>{o.title} <span className="badge draft">{STAGE_LABELS[o.stage]}</span></h1>
      <Flash sp={sp} />
      <dl>
        <div className="row"><dt>Prospecto</dt><dd><Link href={`/prospects/${o.prospect.id}`}>{o.prospect.name}</Link></dd></div>
        <div className="row"><dt>Responsable</dt><dd>{o.ownerName ?? "Sin asignar (cola)"}{o.assignedAt ? ` · desde ${formatDate(o.assignedAt)}` : ""}</dd></div>
        <div className="row"><dt>Valor esperado</dt><dd>{o.expectedValue ? `${o.expectedValue} ${o.currency}` : "—"}</dd></div>
        <div className="row"><dt>Primera atención</dt><dd>{o.firstContactedAt ? formatDate(o.firstContactedAt) : "pendiente"}{o.firstResponseDueAt ? ` · límite ${formatDate(o.firstResponseDueAt)}` : ""}{o.slaBreached ? " · SLA vencido" : ""}</dd></div>
        {o.lossReason ? <div className="row"><dt>Motivo de pérdida</dt><dd>{o.lossReason}</dd></div> : null}
      </dl>

      {can("crm:work") && !closed ? (
        <>
          <h2>Cambiar etapa</h2>
          <form method="post" action={`/actions/crm/${o.id}/stage`} className="inline">
            <label>Nueva etapa<select name="stage" required>{next.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}</select></label>
            <label>Nota (opcional)<input name="note" maxLength={300} /></label>
            <label>Motivo si se pierde<input name="lossReason" maxLength={200} /></label>
            <button type="submit">Mover</button>
          </form>
        </>
      ) : null}
      {can("crm:manage") && !closed ? (
        <>
          <h2>Asignación</h2>
          <form method="post" action={`/actions/crm/${o.id}/assign`} className="inline">
            <label>Asignar a<select name="userId"><option value="">Cola (sin asignar)</option>{pool?.ok ? pool.data.items.filter((m) => m.active).map((m) => <option key={m.userId} value={m.userId}>{m.displayName} ({m.openCount}/{m.maxOpen})</option>) : null}</select></label>
            <button type="submit">Asignar</button>
          </form>
          <form method="post" action={`/actions/crm/${o.id}/auto-assign`} className="inline-form"><button type="submit" className="secondary">Asignar automáticamente (round-robin)</button></form>
        </>
      ) : null}

      <h2>Cotizaciones</h2>
      {quotes?.ok && quotes.data.items.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr">Cotizaciones de la oportunidad</caption>
            <thead><tr><th scope="col">Número</th><th scope="col">Estado</th><th scope="col">Total</th></tr></thead>
            <tbody>{quotes.data.items.map((q) => <tr key={q.id}><td><Link href={`/quotes/${q.id}`}>{q.label}</Link></td><td>{QUOTE_LABELS[q.status]}</td><td>{q.total} {q.currency}</td></tr>)}</tbody>
          </table>
        </div>
      ) : <p className="empty">Sin cotizaciones.</p>}
      {can("quotes:manage") && !closed ? (
        lists?.ok && lists.data.items.length ? (
          <form method="post" action="/actions/quotes/create" className="inline">
            <input type="hidden" name="opportunityId" value={o.id} />
            <label>Lista de precios aprobada<select name="priceListId" required>{lists.data.items.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.currency})</option>)}</select></label>
            <label>Vigente hasta<input name="validUntil" type="date" /></label>
            <label>Impuesto (%) opcional<input name="taxRate" inputMode="decimal" pattern="[0-9]{1,3}(\.[0-9]{1,4})?" /></label>
            <button type="submit">Nueva cotización</button>
          </form>
        ) : <p className="hint">Para cotizar se necesita al menos una lista de precios aprobada.</p>
      ) : null}

      {can("crm:work") ? (
        <>
          <h2>Registrar actividad</h2>
          <form method="post" action={`/actions/crm/${o.id}/note`}>
            <label>Tipo<select name="kind"><option value="note">Nota</option><option value="call">Llamada</option><option value="email">Correo</option><option value="meeting">Reunión</option></select></label>
            <label>Detalle<textarea name="body" required rows={3} maxLength={2000} /></label>
            <button type="submit">Registrar</button>
          </form>
        </>
      ) : null}

      <h2>Historial</h2>
      <ol className="timeline">
        {o.timeline.map((t, i) => (
          <li key={i}>
            <span className="hint">{formatDate(t.at)} · {t.by ?? "sistema"}</span>{" "}
            {t.kind === "stage" ? <>Etapa: {t.from ? `${STAGE_LABELS[t.from]} → ` : ""}<strong>{STAGE_LABELS[t.to]}</strong>{t.note ? ` — ${t.note}` : ""}</> : null}
            {t.kind === "note" ? <>[{t.noteKind}] {t.body}</> : null}
            {t.kind === "assignment" ? <>Asignación ({t.strategy}): {t.assignedTo ?? "cola"}</> : null}
          </li>
        ))}
      </ol>
    </>
  );
}

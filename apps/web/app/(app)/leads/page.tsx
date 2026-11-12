import Link from "next/link";
import type { LeadPageDto, LeadSettingsDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { formatDate, pick } from "../../../lib/format";
import { Flash } from "../../components/flash";

const STATES = ["all", "pending_review", "accepted", "rejected"] as const;
const STATE_LABELS: Record<string, string> = { pending_review: "Pendiente de revisión", accepted: "Aceptado", rejected: "Rechazado" };
const ORIGIN: Record<string, string> = { rule: "Regla de puntuación", intent: "Respuesta clasificada" };
const INTENT: Record<string, string> = { purchase: "Compra", quote: "Cotización", info: "Información", call: "Llamada" };

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ state?: string; ok?: string; error?: string; created?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  const state = pick(sp.state, STATES) ?? "all";
  const can = (p: string) => (me.permissions as readonly string[]).includes(p);
  if (!can("leads:read")) return <p role="alert" className="notice error">Tu rol no tiene acceso a los leads (los vendedores los verán cuando se asignen).</p>;
  const [list, settings] = await Promise.all([api<LeadPageDto>(`/leads?state=${state}&limit=50`, { token }), api<LeadSettingsDto>("/leads/settings", { token })]);
  if (!list.ok || !settings.ok) throw new Error("Leads could not be loaded");
  return (
    <>
      <header className="page-head">
        <h1>Leads</h1>
      </header>
      <Flash sp={sp} />
      <p className="hint">Un lead se crea sólo por una regla explícita (puntuación igual o mayor al umbral, prospecto calificado y fuera de la lista de no contactar) o por una respuesta con intención positiva. Siempre lo revisa una persona.</p>
      <p>Umbral mínimo: <strong>{settings.data.minScore ?? "sin configurar"}</strong>{settings.data.minScore === null ? " — no se crean leads por regla hasta que un administrador lo defina." : ""}</p>
      {can("scoring:approve") ? (
        <form method="post" action="/actions/scoring/settings" className="inline">
          <label>Umbral mínimo de puntuación<input name="minScore" required inputMode="numeric" pattern="-?[0-9]{1,4}" defaultValue={settings.data.minScore ?? ""} /></label>
          <button type="submit" className="secondary">Guardar umbral</button>
        </form>
      ) : null}
      {can("leads:review") ? <form method="post" action="/actions/leads/evaluate" className="inline-form"><button type="submit">Evaluar reglas y crear leads</button></form> : null}
      <p className="toolbar"><Link href="/scoring">Modelo de puntuación</Link></p>
      <form method="get" className="filters" aria-label="Filtros">
        <label>Estado<select name="state" defaultValue={state}>{STATES.map((s) => <option key={s} value={s}>{s === "all" ? "Todos" : STATE_LABELS[s]}</option>)}</select></label>
        <button type="submit">Filtrar</button>
      </form>
      {list.data.items.length === 0 ? <p className="empty">No hay leads con este filtro.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Leads</caption>
            <thead><tr><th scope="col">Prospecto</th><th scope="col">Origen y evidencia</th><th scope="col">Estado</th><th scope="col">Creado</th>{can("leads:review") ? <th scope="col">Revisión</th> : null}</tr></thead>
            <tbody>
              {list.data.items.map((l) => (
                <tr key={l.id}>
                  <td><Link href={`/prospects/${l.prospect.id}`}>{l.prospect.name}</Link></td>
                  <td>{ORIGIN[l.origin]}: {l.origin === "rule" ? `puntuación ${l.scoreTotal} ≥ umbral ${l.minScore}` : (INTENT[l.intentClass ?? ""] ?? l.intentClass)}</td>
                  <td><span className={`badge ${l.state === "accepted" ? "approved" : l.state === "pending_review" ? "draft" : "archived"}`}>{STATE_LABELS[l.state]}</span>{l.reviewNote ? <span className="hint"> · {l.reviewNote}</span> : null}</td>
                  <td>{formatDate(l.createdAt)}</td>
                  {can("leads:review") ? (
                    <td>
                      {l.state === "pending_review" ? (
                        <form method="post" action={`/actions/leads/${l.id}`} className="inline">
                          <label>Nota<input name="note" maxLength={300} /></label>
                          <button type="submit" name="decision" value="accept">Aceptar</button>
                          <button type="submit" name="decision" value="reject" className="secondary">Rechazar</button>
                        </form>
                      ) : l.state === "accepted" && can("crm:manage") ? (
                        <form method="post" action="/actions/crm/opportunity" className="inline">
                          <input type="hidden" name="leadId" value={l.id} />
                          <label>Título<input name="title" required maxLength={200} defaultValue={`Oportunidad ${l.prospect.name}`} /></label>
                          <button type="submit" className="secondary">Crear oportunidad</button>
                        </form>
                      ) : "—"}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

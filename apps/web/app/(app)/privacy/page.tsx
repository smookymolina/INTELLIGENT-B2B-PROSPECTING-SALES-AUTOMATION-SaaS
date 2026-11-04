import { RETENTION_CLASSES, type PrivacyRequestListDto, type RetentionPolicyDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { formatDate, pick } from "../../../lib/format";
import { Flash } from "../../components/flash";

const STATES = ["open", "completed", "rejected", "all"] as const;
const STATE_LABELS: Record<string, string> = { open: "Abierta", completed: "Completada", rejected: "Rechazada", all: "Todas" };
const KIND: Record<string, string> = { access: "Acceso", restrict: "Restricción", erase: "Supresión (irreversible)" };
const CLASS: Record<string, string> = { import_jobs: "Importaciones", sessions: "Sesiones", invitations: "Invitaciones" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PrivacyPage({ searchParams }: { searchParams: Promise<{ state?: string; contactId?: string; eligible?: string; ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  if (!me.permissions.includes("privacy:manage")) return <p role="alert" className="notice error">Tu rol no tiene acceso a privacidad.</p>;
  const state = pick(sp.state, STATES) ?? "open";
  const [policy, requests] = await Promise.all([
    api<RetentionPolicyDto>("/privacy/retention", { token }),
    api<PrivacyRequestListDto>(`/privacy/requests${state === "all" ? "" : `?status=${state}`}`, { token }),
  ]);
  if (!policy.ok || !requests.ok) throw new Error("Privacy data could not be loaded");
  const days = new Map(policy.data.policies.map((p) => [p.dataClass, p.retentionDays]));
  const contactId = sp.contactId && UUID.test(sp.contactId) ? sp.contactId : "";
  return (
    <>
      <h1>Privacidad</h1>
      <Flash sp={sp} />
      {sp.eligible ? <p role="status" className="notice ok">Simulación: {Number(sp.eligible) || 0} filas serían eliminadas. No se borró nada.</p> : null}

      <h2>Retención de datos</h2>
      <p className="hint">Sin plazo configurado <strong>no se borra nada</strong>. Los plazos son decisión de tu organización (30 a 3650 días).</p>
      <form method="post" action="/actions/privacy/retention" className="stack">
        {RETENTION_CLASSES.map((c) => (
          <label key={c}>{CLASS[c]} (días)<input type="number" name={`days_${c}`} min={30} max={3650} defaultValue={days.get(c) ?? ""} placeholder="Sin plazo" /></label>
        ))}
        <button type="submit">Guardar plazos</button>
      </form>
      <form method="post" action="/actions/privacy/run" className="stack">
        <label><input type="checkbox" name="confirm" value="yes" /> Entiendo que la purga real elimina datos de forma irreversible</label>
        <button type="submit">Ejecutar (sin marcar = sólo simular)</button>
      </form>

      <h2>Solicitudes del titular</h2>
      <form method="post" action="/actions/privacy/create" className="stack">
        <label>Identificador del contacto<input name="contactId" defaultValue={contactId} required pattern="[0-9a-fA-F\-]{36}" /></label>
        <label>Tipo<select name="kind" defaultValue="access">{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <button type="submit">Abrir solicitud</button>
      </form>
      <form method="get" className="filters" aria-label="Filtros">
        <label>Estado<select name="state" defaultValue={state}>{STATES.map((s) => <option key={s} value={s}>{STATE_LABELS[s]}</option>)}</select></label>
        <button type="submit">Filtrar</button>
      </form>
      {requests.data.items.length === 0 ? <p className="empty">Sin solicitudes con este filtro.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Solicitudes del titular</caption>
            <thead><tr><th scope="col">Abierta</th><th scope="col">Tipo</th><th scope="col">Estado</th><th scope="col">Vence (informativo)</th><th scope="col">Acciones</th></tr></thead>
            <tbody>
              {requests.data.items.map((r) => (
                <tr key={r.id}>
                  <td>{formatDate(r.requestedAt)}</td><td>{KIND[r.kind]}</td><td>{STATE_LABELS[r.status]}</td><td>{formatDate(r.dueAt)}</td>
                  <td>
                    {r.status === "open" ? (
                      <>
                        <form method="post" action="/actions/privacy/complete" className="inline"><input type="hidden" name="id" value={r.id} /><button type="submit">Completar{r.kind === "access" ? " y descargar" : ""}<span className="sr"> solicitud {r.id.slice(0, 8)}</span></button></form>
                        <form method="post" action="/actions/privacy/reject" className="inline"><input type="hidden" name="id" value={r.id} /><label>Motivo<input name="note" required minLength={3} maxLength={500} /></label><button type="submit">Rechazar</button></form>
                      </>
                    ) : r.kind === "restrict" && r.status === "completed" ? (
                      <form method="post" action="/actions/privacy/lift" className="inline"><input type="hidden" name="id" value={r.id} /><input type="hidden" name="contactId" value={r.contactId} /><label>Motivo<input name="note" required minLength={3} maxLength={500} /></label><button type="submit">Levantar restricción</button></form>
                    ) : (r.note ?? "—")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

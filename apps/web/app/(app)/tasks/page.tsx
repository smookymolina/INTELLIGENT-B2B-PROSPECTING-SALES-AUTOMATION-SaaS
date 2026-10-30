import Link from "next/link";
import type { TaskPageDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { formatDate, pick } from "../../../lib/format";
import { Flash } from "../../components/flash";

const STATES = ["open", "done", "cancelled", "all"] as const;
const STATE_LABELS: Record<string, string> = { open: "Abierta", done: "Hecha", cancelled: "Cancelada", all: "Todas" };

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ state?: string; mine?: string; overdue?: string; cursor?: string; ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  if (!me.permissions.includes("crm:read")) return <p role="alert" className="notice error">Tu rol no tiene acceso a las tareas.</p>;
  const state = pick(sp.state, STATES) ?? "open";
  const query = new URLSearchParams({ state, limit: "50" });
  if (sp.mine === "1") query.set("assignee", "me");
  if (sp.overdue === "1") query.set("overdue", "true");
  if (sp.cursor && /^[0-9a-f-]{36}$/i.test(sp.cursor)) query.set("cursor", sp.cursor);
  const result = await api<TaskPageDto>(`/tasks?${query}`, { token });
  if (!result.ok) throw new Error("The tasks could not be loaded");
  const canWork = me.permissions.includes("crm:work");
  const next = new URLSearchParams({ state, ...(sp.mine === "1" ? { mine: "1" } : {}), ...(sp.overdue === "1" ? { overdue: "1" } : {}), cursor: result.data.nextCursor ?? "" });
  return (
    <>
      <h1>Tareas de seguimiento</h1>
      <Flash sp={sp} />
      <p className="hint">Los vendedores ven sólo las tareas de sus oportunidades. Las fechas se muestran en UTC.</p>
      <form method="get" className="filters" aria-label="Filtros">
        <label>Estado<select name="state" defaultValue={state}>{STATES.map((s) => <option key={s} value={s}>{STATE_LABELS[s]}</option>)}</select></label>
        <label><input type="checkbox" name="mine" value="1" defaultChecked={sp.mine === "1"} /> Sólo mías</label>
        <label><input type="checkbox" name="overdue" value="1" defaultChecked={sp.overdue === "1"} /> Sólo vencidas</label>
        <button type="submit">Filtrar</button>
      </form>
      {result.data.items.length === 0 ? <p className="empty">Sin tareas con estos filtros.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Tareas</caption>
            <thead><tr><th scope="col">Vence</th><th scope="col">Tarea</th><th scope="col">Oportunidad</th><th scope="col">Estado</th>{canWork ? <th scope="col">Acciones</th> : null}</tr></thead>
            <tbody>
              {result.data.items.map((t) => (
                <tr key={t.id}>
                  <td>{formatDate(t.dueAt)}{t.overdue ? " · vencida" : ""}</td><td>{t.title}</td>
                  <td><Link href={`/pipeline/${t.opportunityId}`}>{t.opportunityTitle}</Link></td><td>{STATE_LABELS[t.state]}</td>
                  {canWork ? (
                    <td>
                      {t.state === "open" ? (
                        <>
                          <form method="post" action={`/actions/tasks/${t.id}/complete`} className="inline-form"><button type="submit">Completar</button></form>
                          <form method="post" action={`/actions/tasks/${t.id}/cancel`} className="inline-form"><button type="submit" className="secondary">Cancelar</button></form>
                        </>
                      ) : "—"}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.data.nextCursor ? <p><Link href={`/tasks?${next}`}>Siguiente página →</Link></p> : null}
    </>
  );
}

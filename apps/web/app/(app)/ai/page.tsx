import type { AiRunPageDto, AiUsageDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { formatDate } from "../../../lib/format";
import { Flash } from "../../components/flash";

const STATUS: Record<string, string> = { ok: "Correcta", needs_review: "Requiere revisión", blocked: "Bloqueada (sin evidencia)", budget_exceeded: "Sin presupuesto", provider_error: "Proveedor no disponible", schema_invalid: "Respuesta inválida" };
const units = (micros: number | null) => (micros === null ? "—" : (micros / 1_000_000).toFixed(4));

export default async function AiPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  if (!me.permissions.includes("ai:use")) return <p role="alert" className="notice error">Tu rol no tiene acceso a la IA.</p>;
  const [usage, runs] = await Promise.all([api<AiUsageDto>("/ai/usage", { token }), api<AiRunPageDto>("/ai/runs?limit=20", { token })]);
  if (!usage.ok || !runs.ok) throw new Error("The AI data could not be loaded");
  const u = usage.data;
  const canManage = me.permissions.includes("ai:manage");
  return (
    <>
      <header className="page-head">
        <h1>Asistente de IA</h1>
      </header>
      <Flash sp={sp} />
      <p className="hint">La IA sólo sugiere: nunca envía mensajes ni cambia datos. Sólo ve evidencia aprobada del catálogo (referencias <code>item:…</code> y <code>price:…</code>), con datos personales ocultos. Lo dudoso queda marcado para revisión humana. Sin presupuesto configurado la IA está bloqueada.</p>
      <dl className="stats">
        <div><dt>Gastado este mes (UTC)</dt><dd>{units(u.spentMicros)}</dd></div>
        <div><dt>Límite mensual</dt><dd>{units(u.monthlyLimitMicros)}</dd></div>
        <div><dt>Disponible</dt><dd>{units(u.remainingMicros)}</dd></div>
        <div><dt>Ejecuciones</dt><dd>{u.runs}</dd></div>
        <div><dt>Por revisar</dt><dd>{u.needsReview}</dd></div>
      </dl>
      {canManage ? (
        <form method="post" action="/actions/ai/budget" className="inline" aria-label="Presupuesto">
          <label>Límite mensual (unidades, hasta 6 decimales)<input name="limit" inputMode="decimal" required pattern="[0-9]{1,6}(\.[0-9]{1,6})?" defaultValue={u.monthlyLimitMicros === null ? "" : String(u.monthlyLimitMicros / 1_000_000)} /></label>
          <button type="submit">Guardar presupuesto</button>
        </form>
      ) : null}

      <h2>Analizar</h2>
      <form method="post" action="/actions/ai/analyze" aria-label="Analizar">
        <label>Referencias de evidencia (una por línea, hasta 10)<textarea name="refs" required rows={3} maxLength={2000} placeholder="item:<id>:v1&#10;price:<id>" /></label>
        <label>Texto del cliente (se tratará como dato no confiable)<textarea name="text" required rows={4} maxLength={4000} /></label>
        <button type="submit">Pedir sugerencia</button>
      </form>

      <h2>Ejecuciones recientes</h2>
      {runs.data.items.length === 0 ? <p className="empty">Aún no hay ejecuciones.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Ejecuciones de IA</caption>
            <thead><tr><th scope="col">Fecha</th><th scope="col">Estado</th><th scope="col">Sugerencia</th><th scope="col">Banderas</th><th scope="col">Costo</th></tr></thead>
            <tbody>
              {runs.data.items.map((r) => (
                <tr key={r.id}>
                  <td>{formatDate(r.createdAt)}</td>
                  <td>{STATUS[r.status] ?? r.status}{r.needsReview ? " · revisar" : ""}</td>
                  <td>{r.output ? <>{r.output.summary}<br /><span className="hint">Evidencia: {r.output.evidenceIds.join(", ") || "—"} · confianza {r.confidence ?? "—"} · {r.provider}/{r.model} · prompt {r.promptKey} v{r.promptVersion}</span></> : "—"}</td>
                  <td>{r.flags.length ? r.flags.join(", ") : "—"}</td><td>{units(r.costMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

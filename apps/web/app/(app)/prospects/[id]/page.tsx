import Link from "next/link";
import { notFound } from "next/navigation";
import type { AttributeListDto, IntentAssessmentListDto, ProspectDetailDto, ProspectScoreDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { formatDate } from "../../../../lib/format";
import { Flash } from "../../../components/flash";

const LABELS: Record<string, string> = { candidate: "Candidato", qualified: "Calificado", disqualified: "Descalificado" };
const SOURCE: Record<string, string> = { manual: "Captura manual", csv_import: "Importación CSV" };
const ATTR_STATUS: Record<string, string> = { unverified: "Sin verificar", verified: "Verificado", rejected: "Rechazado" };
const CONF: Record<string, string> = { low: "Baja", medium: "Media", high: "Alta" };
const INTENT: Record<string, string> = {
  purchase: "Compra", quote: "Cotización", info: "Información", call: "Llamada", future: "Futuro", no_interest: "Sin interés", unsubscribe: "Baja (no contactar)",
  auto_reply: "Respuesta automática", irrelevant: "Irrelevante", review: "Requiere revisión humana",
};

export default async function ProspectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const result = await api<ProspectDetailDto>(`/prospects/${id}`, { token });
  if (!result.ok && (result.status === 404 || result.status === 400)) notFound();
  if (!result.ok) throw new Error("The prospect could not be loaded");
  const p = result.data;
  const manage = me.permissions.includes("prospects:manage");
  const [attrs, score, replies] = await Promise.all([
    api<AttributeListDto>(`/prospects/${id}/attributes`, { token }),
    api<ProspectScoreDto>(`/prospects/${id}/score`, { token }),
    api<IntentAssessmentListDto>(`/prospects/${id}/replies`, { token }),
  ]);
  return (
    <>
      <p><Link href="/prospects">← Prospectos</Link></p>
      <h1>{p.name} <span className={`badge ${p.status === "qualified" ? "approved" : p.status === "candidate" ? "draft" : "archived"}`}>{LABELS[p.status]}</span></h1>
      <Flash sp={sp} />
      {p.suppressed ? <p role="alert" className="notice error">Está en la lista de no contactar: no puede calificarse ni usarse en campañas.</p> : null}
      <p className="hint">Permiso de contacto: <strong>ninguno</strong>. Calificar un prospecto no concede permiso para contactarlo.</p>
      <dl>
        <div className="row"><dt>Dominio</dt><dd>{p.domain ?? "—"}</dd></div>
        <div className="row"><dt>País / región / ciudad</dt><dd>{[p.country, p.region, p.city].filter(Boolean).join(" · ") || "—"}</dd></div>
        <div className="row"><dt>Giro</dt><dd>{p.industry ?? "—"}</dd></div>
        <div className="row"><dt>Notas</dt><dd>{p.notes ?? "—"}</dd></div>
        <div className="row"><dt>Motivo de estado</dt><dd>{p.statusReason ?? "—"}</dd></div>
      </dl>
      <h2>Procedencia</h2>
      <div className="table-wrap">
        <table>
          <caption className="sr">Procedencia</caption>
          <thead><tr><th scope="col">Origen</th><th scope="col">Referencia</th><th scope="col">Fecha</th></tr></thead>
          <tbody>{p.sources.map((s) => <tr key={s.id}><td>{SOURCE[s.type] ?? s.type}</td><td>{s.ref ? <code>{s.ref.slice(0, 8)}…</code> : "—"}</td><td>{formatDate(s.collectedAt)}</td></tr>)}</tbody>
        </table>
      </div>
      <h2>Puntuación</h2>
      {score.ok && score.data.result ? (
        <>
          <p><strong>{score.data.result.total}</strong> puntos · modelo v{score.data.result.modelVersion} · {formatDate(score.data.result.computedAt)}{score.data.stale ? " · desactualizada (hay un modelo más nuevo)" : ""}</p>
          <div className="table-wrap">
            <table>
              <caption className="sr">Desglose de la puntuación</caption>
              <thead><tr><th scope="col">Regla</th><th scope="col">Coincide</th><th scope="col">Puntos</th><th scope="col">Evidencia</th></tr></thead>
              <tbody>{score.data.result.breakdown.map((b) => <tr key={b.ruleId}><td>{b.label}</td><td>{b.matched ? "Sí" : "No"}</td><td>{b.points}</td><td>{b.evidence ? <code>{b.evidence.slice(0, 40)}</code> : "—"}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      ) : <p className="empty">Sin puntuación todavía.</p>}
      {manage ? <form method="post" action={`/actions/prospects/${p.id}/score`} className="inline-form"><button type="submit" className="secondary">Calcular puntuación</button></form> : null}

      <h2>Atributos de enriquecimiento</h2>
      <p className="hint">Los valores nuevos nunca sobrescriben a los existentes: un valor distinto para la misma clave queda como conflicto hasta que una persona verifica uno. Sólo los verificados puntúan.</p>
      {attrs.ok && attrs.data.items.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr">Atributos</caption>
            <thead><tr><th scope="col">Clave</th><th scope="col">Valor</th><th scope="col">Confianza</th><th scope="col">Estado</th>{manage ? <th scope="col">Decisión</th> : null}</tr></thead>
            <tbody>
              {attrs.data.items.map((a) => (
                <tr key={a.id}>
                  <td><code>{a.key}</code></td><td>{a.value}{a.conflict ? <span className="badge archived"> conflicto</span> : null}</td><td>{CONF[a.confidence]}</td><td>{ATTR_STATUS[a.status]}</td>
                  {manage ? (
                    <td>
                      <form method="post" action={`/actions/prospects/${p.id}/decision`} className="inline">
                        <input type="hidden" name="attributeId" value={a.id} />
                        {a.status !== "verified" ? <button type="submit" name="decision" value="verify">Verificar</button> : null}
                        {a.status !== "rejected" ? <button type="submit" name="decision" value="reject" className="secondary">Rechazar</button> : null}
                      </form>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="empty">Sin atributos.</p>}
      {manage ? (
        <form method="post" action={`/actions/prospects/${p.id}/attribute`} className="inline">
          <label>Clave (minúsculas y _)<input name="key" required maxLength={40} pattern="[a-z][a-z0-9_]{0,39}" placeholder="employees" /></label>
          <label>Valor<input name="value" required maxLength={200} /></label>
          <label>Confianza<select name="confidence"><option value="low">Baja</option><option value="medium" selected>Media</option><option value="high">Alta</option></select></label>
          <button type="submit">Agregar</button>
        </form>
      ) : null}

      <h2>Respuestas del prospecto</h2>
      <p className="hint">Pega una respuesta recibida: se clasifica con reglas explícitas (sin IA). Una solicitud de baja agrega al prospecto a la lista de no contactar; una intención positiva abre un lead para revisión humana; lo ambiguo queda para revisión.</p>
      {replies.ok && replies.data.items.length ? (
        <ul>{replies.data.items.map((r) => <li key={r.id}><strong>{INTENT[r.class] ?? r.class}</strong>{r.ambiguous ? " (ambigua)" : ""} · {formatDate(r.createdAt)} · <em>«{r.excerpt.slice(0, 120)}»</em>{r.matched.length ? <> · frases: {r.matched.map((m) => m.phrase).join(", ")}</> : null}{r.effects.leadId ? " · abrió un lead" : ""}{r.effects.suppressionCreated ? " · lista de no contactar" : ""}</li>)}</ul>
      ) : <p className="empty">Sin respuestas registradas.</p>}
      {manage ? (
        <form method="post" action={`/actions/prospects/${p.id}/reply`}>
          <label>Texto de la respuesta<textarea name="text" required rows={4} maxLength={4000} /></label>
          <button type="submit">Clasificar</button>
        </form>
      ) : null}

      {manage ? (
        <>
          <h2>Estado</h2>
          <form method="post" action={`/actions/prospects/${p.id}/status`} className="inline">
            <label>Nuevo estado
              <select name="status" defaultValue={p.status}><option value="candidate">Candidato</option><option value="qualified">Calificado</option><option value="disqualified">Descalificado</option></select>
            </label>
            <label>Motivo (si se descalifica)<input name="reason" maxLength={200} /></label>
            <button type="submit">Cambiar estado</button>
          </form>
          <h2>Editar</h2>
          <form method="post" action={`/actions/prospects/${p.id}/update`}>
            <label>Nombre<input name="name" required maxLength={200} defaultValue={p.name} /></label>
            <label>Dominio<input name="domain" maxLength={300} defaultValue={p.domain ?? ""} /></label>
            <label>País (2 letras)<input name="country" maxLength={2} pattern="[A-Za-z]{2}" defaultValue={p.country ?? ""} /></label>
            <label>Estado o región<input name="region" maxLength={100} defaultValue={p.region ?? ""} /></label>
            <label>Ciudad<input name="city" maxLength={100} defaultValue={p.city ?? ""} /></label>
            <label>Giro<input name="industry" maxLength={100} defaultValue={p.industry ?? ""} /></label>
            <label>Notas internas<textarea name="notes" rows={3} maxLength={2000} defaultValue={p.notes ?? ""} /></label>
            <button type="submit">Guardar cambios</button>
          </form>
        </>
      ) : null}
    </>
  );
}

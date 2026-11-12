import Link from "next/link";
import { notFound } from "next/navigation";
import type { AttributeListDto, ContactListDto, IntentAssessmentListDto, ProspectDetailDto, ProspectMergeListDto, ProspectPageDto, ProspectScoreDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { formatDate } from "../../../../lib/format";
import { Flash } from "../../../components/flash";

const LABELS: Record<string, string> = { candidate: "Candidato", qualified: "Calificado", disqualified: "Descalificado" };
const CONTACT_STATUS: Record<string, string> = { active: "Activo", opted_out: "Dado de baja", bounced: "Rebotado" };
const CONSENT: Record<string, string> = { granted: "Otorgado", withdrawn: "Retirado", none: "Ninguno registrado" };
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
  const canContacts = me.permissions.includes("campaigns:read");
  const contacts = canContacts ? await api<ContactListDto>(`/prospects/${id}/contacts`, { token }) : null;
  const [merges, attrs, score, replies] = await Promise.all([
    api<ProspectMergeListDto>(`/prospects/${id}/merges`, { token }),
    api<AttributeListDto>(`/prospects/${id}/attributes`, { token }),
    api<ProspectScoreDto>(`/prospects/${id}/score`, { token }),
    api<IntentAssessmentListDto>(`/prospects/${id}/replies`, { token }),
  ]);
  const mergeItems = merges.ok ? merges.data.items : [];
  const hiddenBehind = mergeItems.find((m) => m.duplicateId === id && m.revertedAt === null) ?? null;
  const absorbed = new Set(mergeItems.filter((m) => m.survivorId === id && m.revertedAt === null).map((m) => m.duplicateId));
  const canMerge = manage && hiddenBehind === null;
  const others = canMerge ? await api<ProspectPageDto>("/prospects?limit=100", { token }) : null;
  const candidates = others?.ok ? others.data.items.filter((o) => o.id !== id && !absorbed.has(o.id)) : [];
  const nameOf = new Map(candidates.map((o) => [o.id, o.name]));
  return (
    <>
      <p><Link href="/prospects">← Prospectos</Link></p>
      <header className="page-head">
        <h1>{p.name} <span className={`badge ${p.status === "qualified" ? "approved" : p.status === "candidate" ? "draft" : "archived"}`}>{LABELS[p.status]}</span></h1>
      </header>
      <Flash sp={sp} />
      {hiddenBehind ? <p role="alert" className="notice error">Este prospecto es un duplicado oculto: está fusionado detrás de <Link href={`/prospects/${hiddenBehind.survivorId}`}>otro prospecto (el sobreviviente)</Link>. {manage ? "Puedes deshacer la fusión desde la sección «Duplicados» de esa ficha." : ""}</p> : null}
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

      {contacts?.ok ? (
        <>
          <h2>Contactos y consentimiento</h2>
          <p className="hint">Un contacto <strong>no implica permiso</strong>: sólo cuenta el consentimiento que una persona registre con su evidencia. Una baja es inmediata y sólo se revierte con un consentimiento nuevo.</p>
          {contacts.data.items.length === 0 ? <p className="empty">Sin contactos.</p> : (
            <div className="table-wrap">
              <table>
                <caption className="sr">Contactos</caption>
                <thead><tr><th scope="col">Mensaje</th><th scope="col">Correo</th><th scope="col">Origen</th><th scope="col">Estado</th><th scope="col">Consentimiento</th>{manage ? <th scope="col">Registrar</th> : null}</tr></thead>
                <tbody>
                  {contacts.data.items.map((c) => (
                    <tr key={c.id}>
                      <td><Link href={`/drafts/new?contactId=${c.id}`}>Preparar mensaje</Link>{me.permissions.includes("privacy:manage") ? <> · <Link href={`/privacy?contactId=${c.id}`}>Privacidad</Link></> : null}</td>
                      <td>{c.address}{c.displayName ? ` (${c.displayName})` : ""}</td><td>{c.source}</td><td>{CONTACT_STATUS[c.status]}</td>
                      <td>{CONSENT[c.consent]}{c.consentAt ? ` · ${formatDate(c.consentAt)}` : ""}</td>
                      {manage ? (
                        <td>
                          <form method="post" action={`/actions/contacts/${c.id}/consent`} className="inline">
                            <input type="hidden" name="prospectId" value={p.id} />
                            <label className="sr" htmlFor={`ev-${c.id}`}>Evidencia</label>
                            <input id={`ev-${c.id}`} name="evidence" required minLength={3} maxLength={500} placeholder="Cómo y dónde se obtuvo / retiró" />
                            <label className="sr" htmlFor={`dt-${c.id}`}>Fecha (UTC)</label>
                            <input id={`dt-${c.id}`} name="occurredAt" type="datetime-local" required />
                            <select name="event" aria-label="Evento"><option value="granted">Consentimiento otorgado</option><option value="withdrawn">Consentimiento retirado</option></select>
                            <button type="submit">Registrar</button>
                          </form>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {manage ? (
            <form method="post" action="/actions/contacts/add" className="inline" aria-label="Nuevo contacto">
              <input type="hidden" name="prospectId" value={p.id} />
              <label>Canal<select name="channel" defaultValue="email"><option value="email">Correo</option><option value="whatsapp">WhatsApp</option></select></label>
              <label>Dirección<input name="address" required maxLength={254} autoComplete="off" aria-describedby="address-help" /></label>
              <p id="address-help" className="hint">Para WhatsApp usa formato internacional, por ejemplo +5215512345678</p>
              <label>Nombre (opcional)<input name="displayName" maxLength={120} /></label>
              <label>Origen del dato<input name="source" required minLength={3} maxLength={300} placeholder="Formulario web, 2026-09-01" /></label>
              <button type="submit">Agregar contacto</button>
            </form>
          ) : null}
        </>
      ) : null}

      <h2 id="duplicados">Duplicados</h2>
      <p className="hint">Ocultar un duplicado detrás de este prospecto no borra ni mueve nada y se puede deshacer. No se permiten cadenas: un prospecto oculto no puede ser sobreviviente ni fusionarse otra vez.</p>
      {mergeItems.length === 0 ? <p className="empty">Sin fusiones registradas.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Historial de fusiones</caption>
            <thead><tr><th scope="col">Fecha</th><th scope="col">Rol de esta ficha</th><th scope="col">Otro prospecto</th><th scope="col">Razón</th><th scope="col">Estado</th>{manage ? <th scope="col">Acción</th> : null}</tr></thead>
            <tbody>
              {mergeItems.map((m) => {
                const survivor = m.survivorId === id;
                const otherId = survivor ? m.duplicateId : m.survivorId;
                return (
                  <tr key={m.id}>
                    <td>{formatDate(m.mergedAt)}</td><td>{survivor ? "Sobreviviente" : "Duplicado oculto"}</td>
                    <td><Link href={`/prospects/${otherId}`}>{nameOf.get(otherId) ?? `${otherId.slice(0, 8)}…`}</Link></td><td>{m.reason}</td>
                    <td>{m.revertedAt ? `Deshecha ${formatDate(m.revertedAt)}` : "Activa"}</td>
                    {manage ? (
                      <td>
                        {m.revertedAt ? "—" : (
                          <form method="post" action={`/actions/prospects/${p.id}/revert`} className="inline-form">
                            <input type="hidden" name="mergeId" value={m.id} />
                            <button type="submit" className="secondary">Deshacer<span className="sr"> fusión del {formatDate(m.mergedAt)}</span></button>
                          </form>
                        )}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {canMerge ? (
        candidates.length === 0 ? <p className="empty">No hay otros prospectos disponibles para ocultar.</p> : (
          <form method="post" action={`/actions/prospects/${p.id}/merge`} className="inline" aria-label="Ocultar un duplicado">
            <label>Prospecto duplicado a ocultar<select name="duplicateId" required defaultValue="">
              <option value="" disabled>Elige un prospecto</option>
              {candidates.map((o) => <option key={o.id} value={o.id}>{o.name}{o.domain ? ` (${o.domain})` : ""}</option>)}
            </select></label>
            <label>Razón (obligatoria)<input name="reason" required minLength={3} maxLength={200} /></label>
            <button type="submit">Ocultar duplicado</button>
          </form>
        )
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

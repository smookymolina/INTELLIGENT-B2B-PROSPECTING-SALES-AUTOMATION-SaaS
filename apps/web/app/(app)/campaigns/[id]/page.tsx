import Link from "next/link";
import { notFound } from "next/navigation";
import type { AttemptPageDto, AudiencePreviewDto, CampaignDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { formatDate } from "../../../../lib/format";
import { Flash } from "../../../components/flash";

const STATES: Record<string, string> = { draft: "Borrador", approved: "Aprobada", running: "En curso", paused: "En pausa", completed: "Completada", cancelled: "Cancelada" };
const REASONS: Record<string, string> = {
  no_consent: "Sin consentimiento vigente", opted_out: "Dados de baja", bounced: "Rebotados", suppressed: "En la lista de no contactar o descalificados",
  recently_contacted: "Contactados hace poco (intervalo mínimo)", already_in_campaign: "Ya incluidos en esta campaña",
};
const ATTEMPT: Record<string, string> = { queued: "En cola", sent: "Enviado", skipped: "Omitido", failed: "Falló", cancelled: "Cancelado" };
const SKIP: Record<string, string> = { ...REASONS };

export default async function CampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  if (!me.permissions.includes("campaigns:read")) return <p role="alert" className="notice error">Tu rol no tiene acceso a las campañas.</p>;
  const result = await api<CampaignDto>(`/campaigns/${id}`, { token });
  if (!result.ok && (result.status === 404 || result.status === 400)) notFound();
  if (!result.ok) throw new Error("The campaign could not be loaded");
  const c = result.data;
  const [preview, attempts] = await Promise.all([api<AudiencePreviewDto>(`/campaigns/${id}/preview`, { token }), api<AttemptPageDto>(`/campaigns/${id}/attempts?limit=50`, { token })]);
  const can = (p: string) => (me.permissions as readonly string[]).includes(p);
  const op = (name: string, label: string, secondary = false) => (
    <form method="post" action={`/actions/campaigns/${c.id}/${name}`} className="inline-form"><button type="submit" className={secondary ? "secondary" : undefined}>{label}</button></form>
  );
  return (
    <>
      <p><Link href="/campaigns">← Campañas</Link></p>
      <header className="page-head">
        <h1>{c.name} <span className="badge draft">{STATES[c.state]}</span></h1>
      </header>
      <Flash sp={sp} />
      <dl>
        <div className="row"><dt>Asunto</dt><dd>{c.subject}</dd></div>
        <div className="row"><dt>Intervalo mínimo</dt><dd>{c.minDaysBetween} días</dd></div>
        <div className="row"><dt>Aprobada</dt><dd>{c.approvedAt ? formatDate(c.approvedAt) : "—"}</dd></div>
        <div className="row"><dt>Iniciada</dt><dd>{c.launchedAt ? formatDate(c.launchedAt) : "—"}</dd></div>
        <div className="row"><dt>Intentos</dt><dd>{c.attempts.queued} en cola · {c.attempts.sent} enviados · {c.attempts.skipped} omitidos · {c.attempts.failed} fallidos · {c.attempts.cancelled} cancelados</dd></div>
      </dl>
      <h2>Mensaje</h2>
      <pre className="message">{c.body}</pre>

      {preview.ok ? (
        <>
          <h2>Audiencia ahora</h2>
          <p><strong>{preview.data.eligible}</strong> de {preview.data.total} contactos son elegibles hoy.</p>
          <ul>{Object.entries(preview.data.excluded).filter(([, n]) => n > 0).map(([k, n]) => <li key={k}>{REASONS[k] ?? k}: {n}</li>)}</ul>
        </>
      ) : null}

      <h2>Acciones</h2>
      <div className="toolbar">
        {can("campaigns:approve") && c.state === "draft" ? op("approve", "Aprobar") : null}
        {can("campaigns:manage") && c.state === "approved" ? op("launch", "Iniciar (encolar elegibles)") : null}
        {can("campaigns:manage") && c.state === "running" ? <>{op("dispatch", "Procesar envíos (hasta 50)")}{op("pause", "Pausar", true)}</> : null}
        {can("campaigns:manage") && c.state === "paused" ? op("resume", "Reanudar") : null}
        {can("campaigns:manage") && !["completed", "cancelled"].includes(c.state) ? op("cancel", "Cancelar campaña", true) : null}
      </div>
      {c.state === "draft" && !can("campaigns:approve") ? <p className="hint">Sólo un administrador o gerente de ventas puede aprobar.</p> : null}

      <h2>Intentos de envío</h2>
      {attempts.ok && attempts.data.items.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr">Intentos</caption>
            <thead><tr><th scope="col">Correo</th><th scope="col">Estado</th><th scope="col">Motivo</th><th scope="col">Mensaje</th><th scope="col">Cuándo</th></tr></thead>
            <tbody>{attempts.data.items.map((a) => <tr key={a.id}><td>{a.address}</td><td>{ATTEMPT[a.state]}</td><td>{a.skipReason ? (SKIP[a.skipReason] ?? a.skipReason) : "—"}</td><td>{a.providerMessageId ?? "—"}</td><td>{formatDate(a.attemptedAt)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : <p className="empty">Sin intentos todavía.</p>}
    </>
  );
}

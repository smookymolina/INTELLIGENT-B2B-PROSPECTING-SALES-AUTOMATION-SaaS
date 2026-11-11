import Link from "next/link";
import { notFound } from "next/navigation";
import type { DraftDeliveryDto, MessageDraftDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { formatDate } from "../../../../lib/format";
import { Flash } from "../../../components/flash";

const STATE_LABELS: Record<string, string> = { pending_review: "Pendiente de revisión", approved: "Aprobado", rejected: "Rechazado" };
const DELIVERY_LABELS: Record<string, string> = { none: "Aún no se ha pedido enviarlo.", queued: "En cola: se enviará en el próximo ciclo del proceso de fondo.", sent: "Enviado.", failed: "El envío falló. Revisa la cuenta de correo en Empresa y reintenta.", skipped: "No se envió porque el contacto ya no es elegible." };

export default async function DraftPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  if (!me.permissions.includes("campaigns:read")) return <p role="alert" className="notice error">Tu rol no tiene acceso a los borradores.</p>;
  const result = await api<MessageDraftDto>(`/message-drafts/${id}`, { token });
  if (!result.ok && (result.status === 404 || result.status === 400)) notFound();
  if (!result.ok) throw new Error("The draft could not be loaded");
  const d = result.data;
  const delivery = d.channel === "email" && d.status === "approved" ? await api<DraftDeliveryDto>(`/message-drafts/${id}/delivery`, { token }) : null;
  const state = delivery?.ok ? delivery.data.state : null;
  const canSend = me.permissions.includes("campaigns:approve") && (state === "none" || state === "failed" || state === "skipped");
  const canDecide = me.permissions.includes("campaigns:approve") && d.status === "pending_review";
  return (
    <>
      <p><Link href="/drafts">← Borradores</Link></p>
      <h1>Borrador de {d.channel === "email" ? "correo" : "WhatsApp"} <span className={`badge ${d.status === "approved" ? "approved" : d.status === "pending_review" ? "draft" : "archived"}`}>{STATE_LABELS[d.status]}</span></h1>
      <Flash sp={sp} />
      <p role="note" className="notice ok">Este borrador no se envía automáticamente, ni siquiera aprobado.{d.channel === "whatsapp" ? " WhatsApp es sólo borrador: no hay proveedor de envío." : ""}</p>
      <dl>
        <div className="row"><dt>Canal</dt><dd>{d.channel === "email" ? "Correo" : "WhatsApp (sólo borrador)"}</dd></div>
        <div className="row"><dt>Autor</dt><dd>{d.authorKind === "mcp" ? "Asistente externo (MCP), pendiente de revisión humana" : "Persona"} · {formatDate(d.createdAt)}</dd></div>
        {d.subject !== null ? <div className="row"><dt>Asunto</dt><dd>{d.subject}</dd></div> : null}
        <div className="row"><dt>Cuerpo</dt><dd style={{ whiteSpace: "pre-wrap" }}>{d.body}</dd></div>
        <div className="row"><dt>Evidencia citada</dt><dd>{d.evidenceRefs.length ? <ul>{d.evidenceRefs.map((r) => <li key={r}><code>{r}</code></li>)}</ul> : "Sin evidencia citada"}</dd></div>
        <div className="row"><dt>Contacto</dt><dd><Link href={`/drafts/new?contactId=${d.contactId}`}>Ver contexto del contacto</Link></dd></div>
        {d.decidedAt ? <div className="row"><dt>Decisión</dt><dd>{STATE_LABELS[d.status]} · {formatDate(d.decidedAt)}{d.decisionNote ? ` · «${d.decisionNote}»` : ""}</dd></div> : null}
      </dl>
      {canDecide ? (
        <>
          <h2>Decisión</h2>
          <form method="post" action={`/actions/drafts/${d.id}/approve`} className="inline"><button type="submit">Aprobar</button></form>
          <form method="post" action={`/actions/drafts/${d.id}/reject`} className="inline" aria-label="Rechazar borrador">
            <label>Nota del rechazo (obligatoria)<input name="note" required maxLength={500} /></label>
            <button type="submit" className="secondary">Rechazar</button>
          </form>
        </>
      ) : null}
      {state ? (
        <>
          <h2>Envío</h2>
          <p role="status">{DELIVERY_LABELS[state]}{delivery?.ok && delivery.data.skipReason ? ` Motivo: ${delivery.data.skipReason}.` : ""}{delivery?.ok && delivery.data.attemptedAt ? ` (${formatDate(delivery.data.attemptedAt)})` : ""}</p>
          {canSend ? (
            <form method="post" action={`/actions/drafts/${d.id}/send`} className="stack" aria-label="Enviar borrador">
              <p className="hint">Se pone en cola y lo envía el proceso de fondo con la cuenta de correo de tu organización, tras volver a comprobar consentimiento y lista de no contactar.</p>
              <button type="submit">{state === "none" ? "Enviar por correo" : "Reintentar envío"}</button>
            </form>
          ) : null}
        </>
      ) : null}
    </>
  );
}

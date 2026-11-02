import Link from "next/link";
import { notFound } from "next/navigation";
import type { OutreachContextDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { Flash } from "../../../components/flash";

export default async function NewDraftPage({ searchParams }: { searchParams: Promise<{ contactId?: string; ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  if (!me.permissions.includes("campaigns:read")) return <p role="alert" className="notice error">Tu rol no tiene acceso a los borradores.</p>;
  const contactId = sp.contactId ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(contactId)) notFound();
  const result = await api<OutreachContextDto>(`/contacts/${contactId}/outreach-context`, { token });
  if (!result.ok && (result.status === 404 || result.status === 400)) notFound();
  if (!result.ok) throw new Error("The outreach context could not be loaded");
  const c = result.data;
  const canCreate = me.permissions.includes("campaigns:manage");
  const where = [c.prospect.industry, c.prospect.city, c.prospect.country].filter(Boolean).join(" · ");
  return (
    <>
      <p><Link href="/drafts">← Borradores</Link></p>
      <h1>Preparar mensaje</h1>
      <Flash sp={sp} />
      <p role="note" className="notice ok">Ningún borrador se envía automáticamente: queda pendiente de revisión y aprobarlo tampoco lo envía. WhatsApp es sólo borrador (no hay proveedor de envío).</p>
      <h2>Contacto</h2>
      <dl>
        <div className="row"><dt>Prospecto</dt><dd>{c.prospect.name}{where ? ` · ${where}` : ""}</dd></div>
        <div className="row"><dt>Contacto</dt><dd>{c.contact.displayName ? `${c.contact.displayName} · ` : ""}<code>{c.contact.addressMasked}</code> (dirección enmascarada) · origen: {c.contact.source}</dd></div>
      </dl>
      <h2>Elegibilidad por canal</h2>
      <div className="table-wrap">
        <table>
          <caption className="sr">Elegibilidad por canal</caption>
          <thead><tr><th scope="col">Canal</th><th scope="col">Elegible</th><th scope="col">Razones</th><th scope="col">Límites</th></tr></thead>
          <tbody>
            <tr>
              <td>Correo</td><td>{c.channels.email.eligible ? "Sí" : "No"}</td><td>{c.channels.email.reasons.length ? c.channels.email.reasons.join("; ") : "—"}</td>
              <td>Asunto hasta {c.constraints.email.subjectMax} caracteres; cuerpo hasta {c.constraints.email.bodyMax}</td>
            </tr>
            <tr>
              <td>WhatsApp (sólo borrador)</td><td>{c.channels.whatsapp.eligible ? "Sí" : "No"}</td><td>{c.channels.whatsapp.reasons.length ? c.channels.whatsapp.reasons.join("; ") : "—"}</td>
              <td>Cuerpo hasta {c.constraints.whatsapp.bodyMax}{c.constraints.whatsapp.templateOnly ? "; sólo plantillas" : ""}. {c.constraints.whatsapp.note}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2>Evidencia aprobada disponible</h2>
      {c.evidence.length === 0 ? <p className="empty">No hay evidencia aprobada y vigente: el borrador no podrá citar nada.</p> : (
        <ul>{c.evidence.map((e) => <li key={e.ref}><strong>{e.kind}</strong>: {e.summary} <code>{e.ref}</code></li>)}</ul>
      )}
      <h2>Nuevo borrador manual</h2>
      {!canCreate ? <p className="hint">Tu rol puede ver el contexto pero no crear borradores.</p> : (
        <form method="post" action="/actions/drafts/create">
          <input type="hidden" name="contactId" value={c.contactId} />
          <label>Canal<select name="channel" required defaultValue="email"><option value="email">Correo</option><option value="whatsapp">WhatsApp (sólo borrador)</option></select></label>
          <label>Asunto (sólo correo; obligatorio en correo)<input name="subject" maxLength={c.constraints.email.subjectMax} /></label>
          <label>Cuerpo<textarea name="body" required rows={8} maxLength={c.constraints.email.bodyMax} /></label>
          {c.evidence.length ? (
            <fieldset>
              <legend>Evidencia que cita este borrador</legend>
              {c.evidence.map((e) => <label key={e.ref}><input type="checkbox" name="evidence" value={e.ref} /> {e.summary}</label>)}
            </fieldset>
          ) : null}
          <button type="submit">Crear borrador para revisión</button>
        </form>
      )}
    </>
  );
}

import Link from "next/link";
import type { MessageDraftPageDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { formatDate, pick } from "../../../lib/format";
import { Flash } from "../../components/flash";

const STATES = ["pending_review", "approved", "rejected", "all"] as const;
const STATE_LABELS: Record<string, string> = { pending_review: "Pendiente de revisión", approved: "Aprobado", rejected: "Rechazado", all: "Todos" };
const CHANNEL: Record<string, string> = { email: "Correo", whatsapp: "WhatsApp (envío manual)" };

export default async function DraftsPage({ searchParams }: { searchParams: Promise<{ state?: string; cursor?: string; ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  if (!me.permissions.includes("campaigns:read")) return <p role="alert" className="notice error">Tu rol no tiene acceso a los borradores.</p>;
  const state = pick(sp.state, STATES) ?? "pending_review";
  const query = new URLSearchParams({ limit: "50" });
  if (state !== "all") query.set("status", state);
  if (sp.cursor && /^[0-9a-f-]{36}$/i.test(sp.cursor)) query.set("cursor", sp.cursor);
  const result = await api<MessageDraftPageDto>(`/message-drafts?${query}`, { token });
  if (!result.ok) throw new Error("The drafts could not be loaded");
  return (
    <>
      <header className="page-head">
        <h1>Borradores de mensajes</h1>
      </header>
      <Flash sp={sp} />
      <p className="hint">Un borrador es texto para que una persona lo revise. <strong>Ningún borrador se envía automáticamente</strong>, ni siquiera aprobado. En WhatsApp, la persona lo envía ella misma desde su número con un enlace. Para crear uno, abre «Preparar mensaje» en un contacto de la ficha del prospecto.</p>
      <form method="get" className="filters" aria-label="Filtros">
        <label>Estado<select name="state" defaultValue={state}>{STATES.map((s) => <option key={s} value={s}>{STATE_LABELS[s]}</option>)}</select></label>
        <button type="submit">Filtrar</button>
      </form>
      {result.data.items.length === 0 ? <p className="empty">Sin borradores con este filtro.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Borradores de mensajes</caption>
            <thead><tr><th scope="col">Creado</th><th scope="col">Canal</th><th scope="col">Asunto o inicio</th><th scope="col">Autor</th><th scope="col">Estado</th><th scope="col">Detalle</th></tr></thead>
            <tbody>
              {result.data.items.map((d) => (
                <tr key={d.id}>
                  <td>{formatDate(d.createdAt)}</td><td>{CHANNEL[d.channel]}</td><td>{d.subject ?? d.body.slice(0, 60)}</td>
                  <td>{d.authorKind === "mcp" ? "Asistente (MCP)" : "Persona"}</td><td>{STATE_LABELS[d.status]}</td>
                  <td><Link href={`/drafts/${d.id}`}>Abrir<span className="sr"> borrador del {formatDate(d.createdAt)}</span></Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.data.nextCursor ? <p><Link href={`/drafts?${new URLSearchParams({ state, cursor: result.data.nextCursor })}`}>Siguiente página →</Link></p> : null}
    </>
  );
}

import Link from "next/link";
import type { CampaignPageDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { formatDate } from "../../../lib/format";
import { Flash } from "../../components/flash";

const STATE_LABELS: Record<string, string> = { draft: "Borrador", approved: "Aprobada", running: "En curso", paused: "En pausa", completed: "Completada", cancelled: "Cancelada" };

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; cursor?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  if (!me.permissions.includes("campaigns:read")) return <p role="alert" className="notice error">Tu rol no tiene acceso a las campañas.</p>;
  const query = new URLSearchParams({ limit: "25" });
  if (sp.cursor && /^[0-9a-f-]{36}$/i.test(sp.cursor)) query.set("cursor", sp.cursor);
  const result = await api<CampaignPageDto>(`/campaigns?${query}`, { token });
  if (!result.ok) throw new Error("The campaigns could not be loaded");
  const canManage = me.permissions.includes("campaigns:manage");
  return (
    <>
      <header className="page-head">
        <h1>Campañas de correo</h1>
      </header>
      <Flash sp={sp} />
      <p className="hint">Sólo se contacta a quien tenga un consentimiento registrado vigente, no esté dado de baja ni en la lista de no contactar, y respetando el intervalo mínimo entre mensajes. Cada contacto se revalida justo antes de cada envío. El canal de envío es de pruebas hasta que se apruebe un proveedor.</p>
      {result.data.items.length === 0 ? <p className="empty">Aún no hay campañas.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Campañas</caption>
            <thead><tr><th scope="col">Nombre</th><th scope="col">Estado</th><th scope="col">Encolados</th><th scope="col">Enviados</th><th scope="col">Omitidos</th><th scope="col">Creada</th></tr></thead>
            <tbody>
              {result.data.items.map((c) => (
                <tr key={c.id}><td><Link href={`/campaigns/${c.id}`}>{c.name}</Link></td><td>{STATE_LABELS[c.state]}</td><td>{c.attempts.queued}</td><td>{c.attempts.sent}</td><td>{c.attempts.skipped}</td><td>{formatDate(c.createdAt)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.data.nextCursor ? <p><Link href={`/campaigns?cursor=${result.data.nextCursor}`}>Siguiente página →</Link></p> : null}
      {canManage ? (
        <>
          <h2>Nueva campaña</h2>
          <form method="post" action="/actions/campaigns/create" aria-label="Nueva campaña">
            <label>Nombre interno<input name="name" required maxLength={120} /></label>
            <label>Asunto (puede usar {"{{company}}"})<input name="subject" required maxLength={200} /></label>
            <label>Mensaje (debe incluir {"{{unsubscribe_url}}"}; puede usar {"{{company}}"})<textarea name="body" required rows={6} maxLength={5000} defaultValue={"Hola {{company}},\n\n\n\nSi no deseas recibir más mensajes: {{unsubscribe_url}}"} /></label>
            <label>Días mínimos entre mensajes al mismo contacto<input name="minDaysBetween" type="number" min={0} max={365} defaultValue={7} /></label>
            <button type="submit">Crear borrador</button>
          </form>
        </>
      ) : null}
    </>
  );
}

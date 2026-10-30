import Link from "next/link";
import type { MemberDto, PoolDto, RoutingSettingsDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { formatDate } from "../../../../lib/format";
import { Flash } from "../../../components/flash";

export default async function RoutingPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  if (!me.permissions.includes("crm:manage")) return <p role="alert" className="notice error">Tu rol no administra la asignación.</p>;
  const [settings, pool, members] = await Promise.all([api<RoutingSettingsDto>("/routing/settings", { token }), api<PoolDto>("/routing/pool", { token }), api<MemberDto[]>("/memberships", { token })]);
  if (!settings.ok || !pool.ok) throw new Error("Routing could not be loaded");
  const candidates = members.ok ? members.data.filter((m) => ["org_admin", "sales_manager", "seller"].includes(m.role) && m.status === "active") : [];
  return (
    <>
      <p><Link href="/pipeline">← Pipeline</Link></p>
      <h1>Asignación de oportunidades</h1>
      <Flash sp={sp} />
      <p className="hint">Sin configuración, la asignación es manual y no hay SLA. El round-robin elige a quien tenga menos oportunidades abiertas (respetando su capacidad); si nadie puede recibirla, queda en la cola. Cada decisión guarda la lista de candidatos para poder reproducirla.</p>
      <form method="post" action="/actions/crm/routing" className="inline">
        <label>Estrategia<select name="strategy" defaultValue={settings.data.strategy}><option value="manual">Manual</option><option value="round_robin">Round-robin al crear</option></select></label>
        <label>SLA de primera atención (minutos, opcional)<input name="firstResponseSlaMinutes" inputMode="numeric" pattern="[0-9]{1,5}" defaultValue={settings.data.firstResponseSlaMinutes ?? ""} /></label>
        <button type="submit">Guardar</button>
      </form>
      <h2>Equipo disponible</h2>
      {pool.data.items.length === 0 ? <p className="empty">Nadie en el pool todavía.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Pool de asignación</caption>
            <thead><tr><th scope="col">Persona</th><th scope="col">Activa</th><th scope="col">Abiertas / capacidad</th><th scope="col">Última asignación</th><th scope="col">Acciones</th></tr></thead>
            <tbody>
              {pool.data.items.map((m) => (
                <tr key={m.userId}>
                  <td>{m.displayName}</td><td>{m.active ? "Sí" : "No"}</td><td>{m.openCount} / {m.maxOpen}</td><td>{formatDate(m.lastAssignedAt)}</td>
                  <td><form method="post" action={`/actions/crm/pool/${m.userId}`} className="inline-form"><button type="submit" className="secondary">Quitar</button></form></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form method="post" action="/actions/crm/pool" className="inline">
        <label>Persona<select name="userId" required>{candidates.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.displayName}</option>)}</select></label>
        <label>Capacidad (oportunidades abiertas)<input name="maxOpen" required inputMode="numeric" pattern="[0-9]{1,3}" defaultValue="10" /></label>
        <label className="check"><input type="checkbox" name="active" defaultChecked /> Activa</label>
        <button type="submit">Agregar o actualizar</button>
      </form>
    </>
  );
}

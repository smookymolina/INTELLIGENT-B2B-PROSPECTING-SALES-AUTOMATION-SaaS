import Link from "next/link";
import { MEMBERSHIP_ROLES, type InvitationDto, type MemberDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { ROLE_LABELS, STATUS_LABELS, formatDate, label } from "../../../lib/format";
import { Flash } from "../../components/flash";

export default async function TeamPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  if (!me.permissions.includes("members:read")) return <p role="alert" className="notice error">Tu rol no tiene acceso al equipo.</p>;
  const canManage = me.permissions.includes("members:manage");
  const [members, invitations] = await Promise.all([
    api<MemberDto[]>("/memberships", { token }),
    canManage ? api<InvitationDto[]>("/invitations", { token }) : Promise.resolve(null),
  ]);
  if (!members.ok || (invitations && !invitations.ok)) throw new Error("The team could not be loaded");
  const roleOptions = MEMBERSHIP_ROLES.map((r) => <option key={r} value={r}>{label(ROLE_LABELS, r)}</option>);
  return (
    <>
      <h1>Equipo</h1>
      <Flash sp={sp} />
      <p className="hint">¿Te invitaron a otra organización? <Link href="/team/accept">Aceptar una invitación</Link>.</p>
      <h2>Miembros</h2>
      <div className="table-wrap">
        <table>
          <caption className="sr">Miembros</caption>
          <thead><tr><th scope="col">Nombre</th><th scope="col">Correo</th><th scope="col">Rol</th><th scope="col">Estado</th>{canManage ? <th scope="col">Acciones</th> : null}</tr></thead>
          <tbody>
            {members.data.map((m) => (
              <tr key={m.id}>
                <td>{m.user.displayName}</td><td>{m.user.email}</td><td>{label(ROLE_LABELS, m.role)}</td><td>{label(STATUS_LABELS, m.status)}</td>
                {canManage ? (
                  <td>
                    {m.user.id === me.user.id ? "—" : (
                      <>
                        <form method="post" action={`/actions/team/member/${m.id}`} className="inline">
                          <input type="hidden" name="op" value="role" />
                          <label className="sr" htmlFor={`role-${m.id}`}>Rol de {m.user.displayName}</label>
                          <select id={`role-${m.id}`} name="role" defaultValue={m.role}>{roleOptions}</select>
                          <button type="submit">Cambiar rol</button>
                        </form>
                        <form method="post" action={`/actions/team/member/${m.id}`} className="inline">
                          <input type="hidden" name="op" value="remove" />
                          <button type="submit">Quitar</button>
                        </form>
                      </>
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && invitations?.ok ? (
        <>
          <h2>Invitaciones pendientes</h2>
          {invitations.data.length === 0 ? <p className="empty">Sin invitaciones pendientes.</p> : (
            <div className="table-wrap">
              <table>
                <caption className="sr">Invitaciones pendientes</caption>
                <thead><tr><th scope="col">Correo</th><th scope="col">Rol</th><th scope="col">Vence</th><th scope="col">Acciones</th></tr></thead>
                <tbody>
                  {invitations.data.map((i) => (
                    <tr key={i.id}>
                      <td>{i.email}</td><td>{label(ROLE_LABELS, i.role)}</td><td>{formatDate(i.expiresAt)}</td>
                      <td><form method="post" action={`/actions/team/invitation/${i.id}`}><button type="submit">Revocar</button></form></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3>Invitar a alguien</h3>
          <p className="hint">Aún no hay proveedor de correo: al crear la invitación verás un código <strong>una sola vez</strong> que debes entregar por un canal seguro.</p>
          <form method="post" action="/actions/team/invite" className="stack" aria-label="Invitar">
            <label>Correo<input name="email" type="email" required maxLength={254} autoComplete="off" /></label>
            <label>Rol<select name="role" defaultValue="viewer">{roleOptions}</select></label>
            <button type="submit">Crear invitación</button>
          </form>
        </>
      ) : null}
    </>
  );
}

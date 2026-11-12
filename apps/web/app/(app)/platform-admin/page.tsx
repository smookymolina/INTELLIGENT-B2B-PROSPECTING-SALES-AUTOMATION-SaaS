import Link from "next/link";
import type { PlatformAdminOrganizationsDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { formatDate } from "../../../lib/format";
import { roleName } from "../../../lib/roles";

const LIMIT = 25;

export default async function PlatformAdminPage({ searchParams }: { searchParams: Promise<{ offset?: string }> }) {
  const { token } = await requireSession();
  const sp = await searchParams;
  const offset = /^\d{1,7}$/.test(sp.offset ?? "") ? Number(sp.offset) : 0;
  const result = await api<PlatformAdminOrganizationsDto>(`/platform-admin/organizations?limit=${LIMIT}&offset=${offset}`, { token });
  if (!result.ok && result.status === 403) return <p role="alert" className="notice error">Sin acceso</p>;
  if (!result.ok) throw new Error("Las organizaciones no se pudieron cargar");
  const { items, total } = result.data;
  return (
    <>
      <header className="page-head">
        <h1>{roleName("platform_admin")}: organizaciones</h1>
      </header>
      <p className="hint">Vista de solo lectura. Cada consulta queda auditada en la organización consultada.</p>
      {items.length === 0 ? <p className="empty">Sin organizaciones.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Organizaciones</caption>
            <thead><tr><th scope="col">Nombre</th><th scope="col">Estado</th><th scope="col">Alta</th><th scope="col">Usuarios</th><th scope="col">Prospectos</th><th scope="col">Leads</th><th scope="col">Oportunidades</th><th scope="col">Cotizaciones</th><th scope="col">Campañas</th></tr></thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.id}>
                  <th scope="row"><Link href={`/platform-admin/${o.id}`}>{o.name}</Link></th><td>{o.status}</td><td>{formatDate(o.createdAt)}</td>
                  <td>{o.counts.users}</td><td>{o.counts.prospects}</td><td>{o.counts.leads}</td><td>{o.counts.opportunities}</td><td>{o.counts.quotes}</td><td>{o.counts.campaigns}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav aria-label="Paginación" className="actions">
        {offset > 0 ? <Link href={`/platform-admin?offset=${Math.max(0, offset - LIMIT)}`}>← Anterior</Link> : null}
        <span className="hint">{total === 0 ? 0 : offset + 1}–{Math.min(offset + LIMIT, total)} de {total}</span>
        {offset + LIMIT < total ? <Link href={`/platform-admin?offset=${offset + LIMIT}`}>Siguiente →</Link> : null}
      </nav>
    </>
  );
}

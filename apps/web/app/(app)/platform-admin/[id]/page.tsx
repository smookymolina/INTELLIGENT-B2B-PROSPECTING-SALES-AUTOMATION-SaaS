import Link from "next/link";
import { notFound } from "next/navigation";
import { PLATFORM_ADMIN_RESOURCES, type PlatformAdminResource, type PlatformAdminResourceDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { pick } from "../../../../lib/format";

const LIMIT = 25;
const TABS: Record<PlatformAdminResource, string> = { users: "Usuarios", prospects: "Prospectos", leads: "Leads", opportunities: "Oportunidades", quotes: "Cotizaciones", campaigns: "Campañas" };
const cell = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

export default async function PlatformAdminOrgPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; offset?: string }> }) {
  const { token } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const tab = pick(sp.tab, PLATFORM_ADMIN_RESOURCES) ?? "users";
  const offset = /^\d{1,7}$/.test(sp.offset ?? "") ? Number(sp.offset) : 0;
  const result = await api<PlatformAdminResourceDto>(`/platform-admin/organizations/${id}/${tab}?limit=${LIMIT}&offset=${offset}`, { token });
  if (!result.ok && result.status === 403) return <p role="alert" className="notice error">Sin acceso</p>;
  if (!result.ok && (result.status === 404 || result.status === 400)) notFound();
  if (!result.ok) throw new Error("Los datos no se pudieron cargar");
  const { items, total } = result.data;
  const columns = [...new Set(items.flatMap((i) => Object.keys(i)))];
  const href = (t: string, o: number) => `/platform-admin/${id}?tab=${t}&offset=${o}`;
  return (
    <>
      <p><Link href="/platform-admin">← Organizaciones</Link></p>
      <h1>Organización (solo lectura)</h1>
      <nav aria-label="Secciones" className="actions">
        {PLATFORM_ADMIN_RESOURCES.map((t) => <Link key={t} href={href(t, 0)} aria-current={t === tab ? "page" : undefined}>{t === tab ? <strong>{TABS[t]}</strong> : TABS[t]}</Link>)}
      </nav>
      {items.length === 0 ? <p className="empty">Sin registros en {TABS[tab].toLowerCase()}.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">{TABS[tab]}</caption>
            <thead><tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
            <tbody>{items.map((row, i) => <tr key={String(row.id ?? i)}>{columns.map((c) => <td key={c}>{cell(row[c])}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
      <nav aria-label="Paginación" className="actions">
        {offset > 0 ? <Link href={href(tab, Math.max(0, offset - LIMIT))}>← Anterior</Link> : null}
        <span className="hint">{total === 0 ? 0 : offset + 1}–{Math.min(offset + LIMIT, total)} de {total}</span>
        {offset + LIMIT < total ? <Link href={href(tab, offset + LIMIT)}>Siguiente →</Link> : null}
      </nav>
    </>
  );
}

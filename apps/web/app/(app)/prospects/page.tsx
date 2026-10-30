import Link from "next/link";
import type { ProspectPageDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { label, pick } from "../../../lib/format";
import { Flash } from "../../components/flash";

const STATUSES = ["all", "candidate", "qualified", "disqualified"] as const;
const SUPPRESSED = ["true", "false"] as const;
const PROSPECT_LABELS: Record<string, string> = { candidate: "Candidato", qualified: "Calificado", disqualified: "Descalificado" };
type Search = { status?: string; suppressed?: string; q?: string; cursor?: string; ok?: string; error?: string };

export default async function ProspectsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { token, me } = await requireSession();
  const raw = await searchParams;
  const status = pick(raw.status, STATUSES) ?? "all";
  const suppressed = pick(raw.suppressed, SUPPRESSED);
  const q = (raw.q ?? "").slice(0, 100).trim();
  const query = new URLSearchParams({ status, limit: "25" });
  if (suppressed) query.set("suppressed", suppressed);
  if (q) query.set("q", q);
  if (raw.cursor && /^[0-9a-f-]{36}$/i.test(raw.cursor)) query.set("cursor", raw.cursor);
  const result = await api<ProspectPageDto>(`/prospects?${query}`, { token });
  if (!result.ok) throw new Error("Prospects could not be loaded");
  const { items, nextCursor } = result.data;
  const next = new URLSearchParams({ status });
  if (suppressed) next.set("suppressed", suppressed);
  if (q) next.set("q", q);
  if (nextCursor) next.set("cursor", nextCursor);
  const manage = me.permissions.includes("prospects:manage");
  return (
    <>
      <h1>Prospectos</h1>
      <Flash sp={raw} />
      <p className="hint">Un prospecto es sólo un <strong>candidato</strong>: no implica permiso para contactarlo.</p>
      <p className="toolbar">
        {manage ? <Link href="/prospects/new">+ Nuevo prospecto</Link> : null}
        {manage ? <Link href="/prospects/import">Importar CSV</Link> : null}
        <Link href="/prospects/suppressions">Lista de no contactar</Link>
        <a href="/export/prospects" download>Exportar CSV</a>
      </p>
      <form method="get" className="filters" aria-label="Filtros">
        <label>Buscar (nombre o dominio)<input name="q" defaultValue={q} maxLength={100} /></label>
        <label>Estado
          <select name="status" defaultValue={status}>{STATUSES.map((s) => <option key={s} value={s}>{s === "all" ? "Todos" : label(PROSPECT_LABELS, s)}</option>)}</select>
        </label>
        <label>No contactar
          <select name="suppressed" defaultValue={suppressed ?? ""}><option value="">Todos</option><option value="true">Sólo en la lista</option><option value="false">Fuera de la lista</option></select>
        </label>
        <button type="submit">Filtrar</button>
      </form>
      {items.length === 0 ? <p className="empty">No hay prospectos con estos filtros. Agrega uno o importa un CSV; todavía no hay conectores de datos externos habilitados.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Prospectos</caption>
            <thead><tr><th scope="col">Nombre</th><th scope="col">Dominio</th><th scope="col">País</th><th scope="col">Estado</th><th scope="col">Lista de no contactar</th></tr></thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td><Link href={`/prospects/${p.id}`}>{p.name}</Link></td>
                  <td>{p.domain ?? "—"}</td>
                  <td>{p.country ?? "—"}</td>
                  <td><span className={`badge ${p.status === "qualified" ? "approved" : p.status === "candidate" ? "draft" : "archived"}`}>{label(PROSPECT_LABELS, p.status)}</span></td>
                  <td>{p.suppressed ? <span className="badge archived">No contactar</span> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor ? <p><Link href={`/prospects?${next}`}>Siguiente página →</Link></p> : null}
      <p className="hint">Conectores de prospección externos: ninguno habilitado (requieren proveedor aprobado).</p>
    </>
  );
}

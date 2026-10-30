import Link from "next/link";
import type { ItemPageDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { KIND_LABELS, STATUS_LABELS, isCursor, label, pick } from "../../../lib/format";

const STATUSES = ["all", "draft", "approved", "archived"] as const;
const KINDS = ["product", "service"] as const;
type Search = { status?: string; kind?: string; cursor?: string };

export default async function CatalogPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { token, me } = await requireSession();
  const raw = await searchParams;
  const status = pick(raw.status, STATUSES) ?? "all";
  const kind = pick(raw.kind, KINDS);
  const query = new URLSearchParams({ status, limit: "25" });
  if (kind) query.set("kind", kind);
  if (isCursor(raw.cursor)) query.set("cursor", raw.cursor);

  const result = await api<ItemPageDto>(`/catalog/items?${query}`, { token });
  if (!result.ok) throw new Error("The catalog could not be loaded");
  const { items, nextCursor } = result.data;
  const next = new URLSearchParams({ status });
  if (kind) next.set("kind", kind);
  if (nextCursor) next.set("cursor", nextCursor);

  return (
    <>
      <h1>Catálogo</h1>
      <p className="toolbar">
        {me.permissions.includes("catalog:manage") ? <Link href="/catalog/new">+ Nuevo elemento</Link> : null}
        <Link href="/catalog/categories">Categorías</Link>
      </p>
      <form method="get" className="filters" aria-label="Filtros">
        <label>Estado
          <select name="status" defaultValue={status}>{STATUSES.map((s) => <option key={s} value={s}>{s === "all" ? "Todos" : label(STATUS_LABELS, s)}</option>)}</select>
        </label>
        <label>Tipo
          <select name="kind" defaultValue={kind ?? ""}><option value="">Todos</option>{KINDS.map((k) => <option key={k} value={k}>{label(KIND_LABELS, k)}</option>)}</select>
        </label>
        <button type="submit">Filtrar</button>
      </form>
      {items.length === 0 ? (
        <p className="empty">No hay elementos con estos filtros. El catálogo se llena desde la API o con una importación CSV; la edición desde esta pantalla llegará en la siguiente etapa.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Elementos del catálogo</caption>
            <thead><tr><th scope="col">SKU</th><th scope="col">Nombre</th><th scope="col">Tipo</th><th scope="col">Estado</th><th scope="col">Versión aprobada</th></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td><Link href={`/catalog/${i.id}`}>{i.sku}</Link></td>
                  <td>{i.approved?.name ?? i.draft?.name ?? "—"}</td>
                  <td>{label(KIND_LABELS, i.kind)}</td>
                  <td><span className={`badge ${i.status}`}>{label(STATUS_LABELS, i.status)}</span>{i.draft && i.status === "approved" ? <span className="hint"> · con borrador</span> : null}</td>
                  <td>{i.approvedVersion ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor ? <p><Link href={`/catalog?${next}`}>Siguiente página →</Link></p> : null}
    </>
  );
}

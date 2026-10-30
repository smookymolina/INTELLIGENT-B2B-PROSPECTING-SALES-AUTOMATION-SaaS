import Link from "next/link";
import type { CategoryDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { STATUS_LABELS, label } from "../../../../lib/format";
import { Flash } from "../../../components/flash";

export default async function CategoriesPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  const result = await api<CategoryDto[]>("/catalog/categories", { token });
  if (!result.ok) throw new Error("Categories could not be loaded");
  const canManage = me.permissions.includes("catalog:manage");
  return (
    <>
      <p><Link href="/catalog">← Catálogo</Link></p>
      <h1>Categorías</h1>
      <Flash sp={sp} />
      {result.data.length === 0 ? <p className="empty">Aún no hay categorías.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Categorías</caption>
            <thead><tr><th scope="col">Nombre</th><th scope="col">Estado</th></tr></thead>
            <tbody>{result.data.map((c) => <tr key={c.id}><td>{c.name}</td><td>{label(STATUS_LABELS, c.status)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {canManage ? (
        <form method="post" action="/actions/catalog/categories" className="inline">
          <label>Nueva categoría<input name="name" required maxLength={100} /></label>
          <button type="submit">Crear</button>
        </form>
      ) : null}
    </>
  );
}

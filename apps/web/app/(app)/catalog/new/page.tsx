import Link from "next/link";
import type { CategoryDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { Flash } from "../../../components/flash";

export default async function NewItemPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  if (!me.permissions.includes("catalog:manage")) return <p role="alert" className="notice error">Tu rol no permite crear elementos del catálogo.</p>;
  const categories = await api<CategoryDto[]>("/catalog/categories", { token });
  const active = categories.ok ? categories.data.filter((c) => c.status === "active") : [];
  return (
    <>
      <p><Link href="/catalog">← Catálogo</Link></p>
      <h1>Nuevo elemento</h1>
      <Flash sp={sp} />
      <p className="hint">Se crea como <strong>borrador</strong>: no se usa en cotizaciones ni IA hasta que un administrador lo apruebe.</p>
      <form method="post" action="/actions/catalog/create">
        <label>Tipo<select name="kind" required><option value="product">Producto</option><option value="service">Servicio</option></select></label>
        <label>SKU (letras, números, . _ -)<input name="sku" required maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}" /></label>
        <label>Nombre<input name="name" required maxLength={200} /></label>
        <label>Descripción<textarea name="description" maxLength={4000} rows={3} /></label>
        <label>Unidad (texto libre, opcional)<input name="unit" maxLength={30} /></label>
        <label>Categoría<select name="categoryId"><option value="">Sin categoría</option>{active.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Características (una por línea, «Nombre: valor»)<textarea name="features" rows={4} maxLength={6000} /></label>
        <button type="submit">Crear borrador</button>
      </form>
    </>
  );
}

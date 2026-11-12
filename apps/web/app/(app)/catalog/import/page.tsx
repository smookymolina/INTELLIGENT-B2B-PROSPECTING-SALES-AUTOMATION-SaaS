import Link from "next/link";
import type { ImportJobDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { Flash } from "../../../components/flash";
import { ImportResult } from "../../../components/import-result";

export default async function CatalogImportPage({ searchParams }: { searchParams: Promise<{ job?: string; ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  if (!me.permissions.includes("catalog:manage")) return <p role="alert" className="notice error">Tu rol no permite importar al catálogo.</p>;
  const job = sp.job && /^[0-9a-f-]{36}$/i.test(sp.job) ? await api<ImportJobDto>(`/catalog/imports/${sp.job}`, { token }) : null;
  return (
    <>
      <p><Link href="/catalog">← Catálogo</Link></p>
      <header className="page-head">
        <h1>Importar catálogo (CSV)</h1>
      </header>
      <Flash sp={sp} />
      <p>Columnas: <code>sku</code>, <code>kind</code> (product|service) y <code>name</code> obligatorias; <code>description</code>, <code>unit</code>, <code>category</code> (existente) y <code>feature:Nombre</code> opcionales. Sólo crea o edita <strong>borradores</strong> (la aprobación es aparte). Todo o nada; máx. 1000 filas. Los precios se cargan en las listas de precios.</p>
      <form method="post" action="/actions/catalog/import">
        <label>Contenido del CSV (con encabezados)<textarea name="csv" rows={10} required maxLength={1000000} spellCheck={false} placeholder={"sku,kind,name\nABC-1,product,Bomba"} /></label>
        <fieldset>
          <legend>Modo</legend>
          <label className="check"><input type="radio" name="mode" value="dry_run" defaultChecked /> Validar sin cambiar nada</label>
          <label className="check"><input type="radio" name="mode" value="apply" /> Aplicar</label>
        </fieldset>
        <button type="submit">Ejecutar</button>
      </form>
      {job?.ok ? <ImportResult job={job.data} /> : null}
    </>
  );
}

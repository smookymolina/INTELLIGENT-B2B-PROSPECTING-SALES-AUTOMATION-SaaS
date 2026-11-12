import Link from "next/link";
import type { ProspectImportJobDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { Flash } from "../../../components/flash";
import { ImportResult } from "../../../components/import-result";

export default async function ProspectImportPage({ searchParams }: { searchParams: Promise<{ job?: string; ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  if (!me.permissions.includes("prospects:manage")) return <p role="alert" className="notice error">Tu rol no permite importar prospectos.</p>;
  const job = sp.job && /^[0-9a-f-]{36}$/i.test(sp.job) ? await api<ProspectImportJobDto>(`/prospects/imports/${sp.job}`, { token }) : null;
  return (
    <>
      <p><Link href="/prospects">← Prospectos</Link></p>
      <header className="page-head">
        <h1>Importar prospectos (CSV)</h1>
      </header>
      <Flash sp={sp} />
      <p>Columnas: <code>name</code> (obligatoria), <code>domain</code>, <code>country</code>, <code>region</code>, <code>city</code>, <code>industry</code>. La clave de deduplicación es el dominio (o nombre + país). Todo o nada; nunca cambia el estado de un prospecto ni concede permiso de contacto; máx. 1000 filas.</p>
      <form method="post" action="/actions/prospects/import">
        <label>Contenido del CSV (con encabezados)<textarea name="csv" rows={10} required maxLength={1000000} spellCheck={false} placeholder={"name,domain,country\nEmpresa Ejemplo,ejemplo.com,MX"} /></label>
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

import Link from "next/link";
import type { SuppressionListDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { formatDate } from "../../../../lib/format";
import { Flash } from "../../../components/flash";

export default async function SuppressionsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  const result = await api<SuppressionListDto>("/suppressions", { token });
  if (!result.ok) throw new Error("The list could not be loaded");
  const can = (p: string) => (me.permissions as readonly string[]).includes(p);
  return (
    <>
      <p><Link href="/prospects">← Prospectos</Link></p>
      <header className="page-head">
        <h1>Lista de no contactar</h1>
      </header>
      <Flash sp={sp} />
      <p className="hint">Los dominios y nombres de esta lista no pueden calificarse ni recibir campañas. Agregar una entrada descalifica al instante a los prospectos calificados que coinciden.</p>
      {result.data.items.length === 0 ? <p className="empty">La lista está vacía.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Entradas</caption>
            <thead><tr><th scope="col">Tipo</th><th scope="col">Valor</th><th scope="col">Motivo</th><th scope="col">Alta</th>{can("suppressions:remove") ? <th scope="col">Acciones</th> : null}</tr></thead>
            <tbody>
              {result.data.items.map((s) => (
                <tr key={s.id}>
                  <td>{s.kind === "domain" ? "Dominio" : "Nombre"}</td><td>{s.value}</td><td>{s.reason}</td><td>{formatDate(s.createdAt)}</td>
                  {can("suppressions:remove") ? <td><form method="post" action={`/actions/prospects/suppressions/${s.id}`} className="inline-form"><button type="submit" className="secondary">Quitar</button></form></td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can("suppressions:manage") ? (
        <form method="post" action="/actions/prospects/suppressions" className="inline">
          <label>Tipo<select name="kind"><option value="domain">Dominio</option><option value="name">Nombre de empresa</option></select></label>
          <label>Valor<input name="value" required maxLength={300} /></label>
          <label>Motivo<input name="reason" required maxLength={200} /></label>
          <button type="submit">Agregar</button>
        </form>
      ) : null}
    </>
  );
}

import type { ScoringModelDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { formatDate } from "../../../lib/format";
import { rulesToText } from "../../../lib/rules";
import { Flash } from "../../components/flash";

export default async function ScoringPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  const result = await api<ScoringModelDto>("/scoring/model", { token });
  if (!result.ok) throw new Error("The scoring model could not be loaded");
  const { approved, draft } = result.data;
  const can = (p: string) => (me.permissions as readonly string[]).includes(p);
  return (
    <>
      <h1>Puntuación de prospectos</h1>
      <Flash sp={sp} />
      <p className="hint">Modelo de reglas transparentes y versionado. Sólo los atributos <strong>verificados</strong> puntúan; cada puntuación explica qué regla coincidió y con qué evidencia. Una versión aprobada es inmutable.</p>
      <div className="two">
        <section aria-labelledby="ap">
          <h2 id="ap">Modelo aprobado</h2>
          {approved ? (
            <>
              <p>Versión {approved.version} · aprobado {formatDate(approved.approvedAt)}</p>
              <div className="table-wrap">
                <table>
                  <caption className="sr">Reglas aprobadas</caption>
                  <thead><tr><th scope="col">Regla</th><th scope="col">Condición</th><th scope="col">Puntos</th></tr></thead>
                  <tbody>{approved.rules.map((r) => <tr key={r.id}><td>{r.label}</td><td><code>{r.source}:{r.name} {r.op} {Array.isArray(r.value) ? r.value.join(", ") : (r.value ?? "")}</code></td><td>{r.points}</td></tr>)}</tbody>
                </table>
              </div>
            </>
          ) : <p className="empty">Todavía no hay un modelo aprobado: nada se puntúa hasta que un administrador lo apruebe.</p>}
        </section>
        <section aria-labelledby="dr">
          <h2 id="dr">Borrador</h2>
          {draft ? <p>Versión {draft.version} (abierto)</p> : <p className="empty">Sin borrador abierto.</p>}
          {can("scoring:manage") ? (
            <form method="post" action="/actions/scoring/draft">
              <label>Reglas (una por línea: <code>id; puntos; fuente:nombre; operador; valor; etiqueta</code>)
                <textarea name="rules" rows={8} spellCheck={false} defaultValue={rulesToText((draft ?? approved)?.rules ?? [])} placeholder={"mx; 30; field:country; eq; MX; País objetivo"} />
              </label>
              <p className="hint">Campos: country, industry, city, region, status, has_domain. Operadores: eq, neq, in, gte, lte, exists, missing.</p>
              <button type="submit">Guardar borrador</button>
            </form>
          ) : null}
          {can("scoring:approve") && draft ? <form method="post" action="/actions/scoring/approve" className="inline-form"><button type="submit">Aprobar borrador</button></form> : null}
        </section>
      </div>
      {can("prospects:manage") && approved ? (
        <form method="post" action="/actions/scoring/recompute" className="inline-form"><button type="submit" className="secondary">Recalcular todas las puntuaciones</button></form>
      ) : null}
    </>
  );
}

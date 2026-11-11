import Link from "next/link";
import { DISCOVERY_CATEGORIES, DISCOVERY_LIMITS, type DiscoveryCategory, type DiscoverySearchDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { Flash } from "../../../components/flash";

const CATEGORY_LABEL: Record<DiscoveryCategory, string> = { office: "Oficinas", shop: "Comercios", craft: "Talleres y oficios", industrial: "Industria" };
type Params = { place?: string; radiusKm?: string; categories?: string | string[]; ok?: string; error?: string; created?: string; dup?: string; sup?: string; nf?: string };
const count = (v: string | undefined) => (v && /^\d{1,3}$/.test(v) ? Number(v) : 0);

export default async function ProspectDiscoveryPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  if (!me.permissions.includes("prospects:manage")) return <p role="alert" className="notice error">Tu rol no permite buscar ni importar prospectos.</p>;

  const place = (sp.place ?? "").trim().slice(0, 200);
  const radius = Math.min(Math.max(Number(sp.radiusKm) || 2, 0.1), DISCOVERY_LIMITS.maxRadiusKm);
  const asked = [sp.categories ?? []].flat();
  const chosen = DISCOVERY_CATEGORIES.filter((c) => asked.includes(c));
  const categories = chosen.length ? chosen : [...DISCOVERY_CATEGORIES];
  const result = place.length >= 2 ? await api<DiscoverySearchDto>("/prospects/discovery/search", { method: "POST", token, body: { place, radiusKm: radius, categories, limit: DISCOVERY_LIMITS.maxResults } }) : null;
  const imported = sp.created !== undefined;

  return (
    <>
      <p><Link href="/prospects">← Prospectos</Link></p>
      <h1>Buscar empresas por zona (OpenStreetMap)</h1>
      <Flash sp={sp} />
      {imported ? (
        <p role="status" className="notice ok">
          Importación terminada: {count(sp.created)} nuevas, {count(sp.dup)} omitidas por duplicadas, {count(sp.sup)} omitidas por estar en la lista de no contactar, {count(sp.nf)} ya no disponibles en OpenStreetMap.
        </p>
      ) : null}
      <p className="hint">Sólo se consultan datos públicos de la empresa (nombre, dirección, teléfono, sitio y correo del negocio). Importar crea <strong>candidatos</strong>: no concede permiso de contacto.</p>

      <form method="get" action="/prospects/discovery">
        <label>Lugar (ciudad, estado, país)<input type="text" name="place" required minLength={2} maxLength={200} defaultValue={place} autoComplete="off" /></label>
        <label>Radio en kilómetros (máx. {DISCOVERY_LIMITS.maxRadiusKm})<input type="number" name="radiusKm" required min={0.1} max={DISCOVERY_LIMITS.maxRadiusKm} step={0.1} defaultValue={radius} /></label>
        <fieldset>
          <legend>Categorías</legend>
          {DISCOVERY_CATEGORIES.map((c) => (
            <label key={c} className="check"><input type="checkbox" name="categories" value={c} defaultChecked={categories.includes(c)} /> {CATEGORY_LABEL[c]}</label>
          ))}
        </fieldset>
        <button type="submit">Buscar</button>
      </form>

      {result && !result.ok ? (
        <p role="alert" className="notice error">
          {result.status === 404
            ? "No se encontró ese lugar. Prueba con un nombre más específico (ciudad, estado, país)."
            : result.status === 400 || result.status === 422
              ? "Revisa el lugar, el radio y las categorías."
              : result.status === 429
                ? "Demasiadas búsquedas seguidas. Espera un momento e intenta de nuevo."
                : "El servicio de mapas no está disponible en este momento. Intenta más tarde."}
        </p>
      ) : null}

      {result?.ok ? (
        <section aria-labelledby="results">
          <h2 id="results">Resultados</h2>
          <p role="status">
            {result.data.items.length} empresas a {result.data.radiusKm} km de «{result.data.place.label}».
            {result.data.truncated ? ` Se muestran las primeras ${DISCOVERY_LIMITS.maxResults}; reduce el radio o las categorías para afinar.` : ""}
          </p>
          {result.data.items.length === 0 ? (
            <p className="empty">No hay empresas con nombre en esa zona para las categorías elegidas. Amplía el radio o agrega categorías.</p>
          ) : (
            <form method="post" action="/actions/prospects/discovery">
              <input type="hidden" name="country" value={result.data.place.country ?? ""} />
              <div className="table-wrap">
                <table>
                  <caption className="sr">Empresas encontradas; marca las que quieras importar</caption>
                  <thead><tr><th scope="col">Importar</th><th scope="col">Empresa</th><th scope="col">Categoría</th><th scope="col">Dirección</th><th scope="col">Contacto del negocio</th><th scope="col">Estado</th></tr></thead>
                  <tbody>
                    {result.data.items.map((i) => (
                      <tr key={i.osmId}>
                        <td>
                          <label className="check">
                            <input type="checkbox" name="osmIds" value={i.osmId} disabled={!i.selectable} />
                            <span className="sr">Importar {i.name}</span>
                          </label>
                        </td>
                        <th scope="row">{i.name}</th>
                        <td>{i.category}</td>
                        <td>{[i.address, i.city, i.region, i.country].filter(Boolean).join(", ") || "—"}</td>
                        <td>{[i.phone, i.website, i.email].filter(Boolean).join(" · ") || "—"}</td>
                        <td>{i.suppressed ? "En lista de no contactar (no se puede importar)" : i.alreadyExists ? "Ya es prospecto" : "Disponible"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="submit" disabled={!result.data.items.some((i) => i.selectable)}>Importar seleccionadas</button>
            </form>
          )}
          <p className="hint">Datos: <a href="https://www.openstreetmap.org/copyright" rel="noreferrer">{result.data.attribution}</a> (licencia ODbL).</p>
        </section>
      ) : null}
    </>
  );
}

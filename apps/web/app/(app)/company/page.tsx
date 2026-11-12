import type { BranchDto, ProfileDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { STATUS_LABELS, formatDate, label } from "../../../lib/format";
import { Flash } from "../../components/flash";

export default async function CompanyPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  const [profile, branches] = await Promise.all([api<ProfileDto>("/organization/profile", { token }), api<BranchDto[]>("/branches", { token })]);
  if (!profile.ok || !branches.ok) throw new Error("The company data could not be loaded");
  const p = profile.data;
  const canEdit = me.permissions.includes("organization:update");
  return (
    <>
      <header className="page-head">
        <h1>Empresa</h1>
      </header>
      <Flash sp={sp} />
      {canEdit ? <p><a href="/company/email">Configurar correo saliente (SMTP)</a></p> : null}
      {p.updatedAt === null ? <p className="empty">El perfil aún no se ha completado. Nada se infiere ni se prellena.</p> : <p className="hint">Actualizado {formatDate(p.updatedAt)}</p>}
      {canEdit ? (
        <form method="post" action="/actions/company/profile" className="stack" aria-label="Perfil de la empresa">
          <p className="hint">Al guardar se reemplaza el perfil completo: los campos vacíos se borran.</p>
          <label>Razón social<input name="legalName" maxLength={200} defaultValue={p.legalName ?? ""} /></label>
          <label>Nombre comercial<input name="tradeName" maxLength={200} defaultValue={p.tradeName ?? ""} /></label>
          <label>Giro<input name="industry" maxLength={100} defaultValue={p.industry ?? ""} /></label>
          <label>Sitio web (http/https)<input name="website" type="url" maxLength={300} defaultValue={p.website ?? ""} /></label>
          <label>Descripción<textarea name="description" maxLength={2000} rows={4} defaultValue={p.description ?? ""} /></label>
          <label>País (ISO, 2 letras)<input name="country" maxLength={2} defaultValue={p.country ?? ""} /></label>
          <label>Zona horaria (IANA)<input name="timezone" maxLength={64} defaultValue={p.timezone ?? ""} /></label>
          <label>Moneda predeterminada (ISO, 3 letras)<input name="defaultCurrency" maxLength={3} defaultValue={p.defaultCurrency ?? ""} /></label>
          <button type="submit">Guardar perfil</button>
        </form>
      ) : (
        <dl>
          {([["Razón social", p.legalName], ["Nombre comercial", p.tradeName], ["Giro", p.industry], ["Sitio web", p.website], ["Descripción", p.description], ["País", p.country], ["Zona horaria", p.timezone], ["Moneda predeterminada", p.defaultCurrency]] as Array<[string, string | null]>).map(([k, v]) => (
            <div key={k} className="row"><dt>{k}</dt><dd>{v ?? "—"}</dd></div>
          ))}
        </dl>
      )}

      <h2>Sedes</h2>
      {branches.data.length === 0 ? <p className="empty">Sin sedes registradas.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Sedes</caption>
            <thead><tr><th scope="col">Nombre</th><th scope="col">Ciudad</th><th scope="col">Región</th><th scope="col">País</th><th scope="col">Estado</th>{canEdit ? <th scope="col">Acciones</th> : null}</tr></thead>
            <tbody>
              {branches.data.map((b) => (
                <tr key={b.id}>
                  <td>{b.name}</td><td>{b.city ?? "—"}</td><td>{b.region ?? "—"}</td><td>{b.country ?? "—"}</td><td>{label(STATUS_LABELS, b.status)}</td>
                  {canEdit ? (
                    <td>
                      <form method="post" action={`/actions/company/branch/${b.id}`}>
                        <input type="hidden" name="op" value={b.status === "active" ? "disable" : "enable"} />
                        <button type="submit">{b.status === "active" ? "Deshabilitar" : "Habilitar"}</button>
                      </form>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canEdit ? (
        <>
          {branches.data.map((b) => (
            <details key={b.id}>
              <summary>Editar sede: {b.name}</summary>
              <form method="post" action={`/actions/company/branch/${b.id}`} className="stack">
                <input type="hidden" name="op" value="save" />
                <label>Nombre<input name="name" required maxLength={120} defaultValue={b.name} /></label>
                <label>Dirección<input name="address" maxLength={300} defaultValue={b.address ?? ""} /></label>
                <label>Ciudad<input name="city" maxLength={100} defaultValue={b.city ?? ""} /></label>
                <label>Región<input name="region" maxLength={100} defaultValue={b.region ?? ""} /></label>
                <label>País (ISO, 2 letras)<input name="country" maxLength={2} defaultValue={b.country ?? ""} /></label>
                <button type="submit">Guardar sede</button>
              </form>
            </details>
          ))}
          <h3>Nueva sede</h3>
          <form method="post" action="/actions/company/branch/new" className="stack" aria-label="Nueva sede">
            <label>Nombre<input name="name" required maxLength={120} /></label>
            <label>Dirección<input name="address" maxLength={300} /></label>
            <label>Ciudad<input name="city" maxLength={100} /></label>
            <label>Región<input name="region" maxLength={100} /></label>
            <label>País (ISO, 2 letras)<input name="country" maxLength={2} /></label>
            <button type="submit">Crear sede</button>
          </form>
        </>
      ) : null}
    </>
  );
}

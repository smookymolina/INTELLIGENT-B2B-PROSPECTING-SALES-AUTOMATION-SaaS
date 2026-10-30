import type { BranchDto, ProfileDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { STATUS_LABELS, formatDate, label } from "../../../lib/format";

export default async function CompanyPage() {
  const { token } = await requireSession();
  const [profile, branches] = await Promise.all([api<ProfileDto>("/organization/profile", { token }), api<BranchDto[]>("/branches", { token })]);
  if (!profile.ok || !branches.ok) throw new Error("The company data could not be loaded");
  const p = profile.data;
  const rows: Array<[string, string | null]> = [
    ["Razón social", p.legalName], ["Nombre comercial", p.tradeName], ["Giro", p.industry], ["Sitio web", p.website], ["Descripción", p.description],
    ["País", p.country], ["Zona horaria", p.timezone], ["Moneda predeterminada", p.defaultCurrency],
  ];
  return (
    <>
      <h1>Empresa</h1>
      {p.updatedAt === null ? <p className="empty">El perfil aún no se ha completado. Nada se infiere ni se prellena.</p> : <p className="hint">Actualizado {formatDate(p.updatedAt)}</p>}
      <dl>{rows.map(([k, v]) => <div key={k} className="row"><dt>{k}</dt><dd>{v ?? "—"}</dd></div>)}</dl>
      <h2>Sedes</h2>
      {branches.data.length === 0 ? <p className="empty">Sin sedes registradas.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Sedes</caption>
            <thead><tr><th scope="col">Nombre</th><th scope="col">Ciudad</th><th scope="col">Región</th><th scope="col">País</th><th scope="col">Estado</th></tr></thead>
            <tbody>{branches.data.map((b) => <tr key={b.id}><td>{b.name}</td><td>{b.city ?? "—"}</td><td>{b.region ?? "—"}</td><td>{b.country ?? "—"}</td><td>{label(STATUS_LABELS, b.status)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

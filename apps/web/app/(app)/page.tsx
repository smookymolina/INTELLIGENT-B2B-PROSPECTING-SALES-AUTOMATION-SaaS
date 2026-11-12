import Link from "next/link";
import { requireSession } from "../../lib/auth";
import { ROLE_LABELS, label } from "../../lib/format";

export default async function HomePage() {
  const { me } = await requireSession();
  return (
    <div className="stack">
      <header className="page-head">
        <h1>Hola, {me.user.displayName}</h1>
      </header>
      <p className="hint">Organización <strong>{me.organization.name}</strong> (<code>{me.organization.slug}</code>) · rol {label(ROLE_LABELS, me.role)}.</p>
      <ul className="cards">
        <li className="card"><Link href="/catalog">Catálogo</Link><span>Productos y servicios, versiones y aprobaciones.</span></li>
        <li className="card"><Link href="/pricing">Precios</Link><span>Listas de precios aprobadas e inmutables.</span></li>
        <li className="card"><Link href="/prospects">Prospectos</Link><span>Candidatos, procedencia y lista de no contactar.</span></li>
        <li className="card"><Link href="/scoring">Puntuación</Link><span>Modelo de reglas transparente y versionado.</span></li>
        {me.permissions.includes("leads:read") ? <li className="card"><Link href="/leads">Leads</Link><span>Creados por regla o intención; los revisa una persona.</span></li> : null}
        {me.permissions.includes("crm:read") ? <li className="card"><Link href="/pipeline">Pipeline</Link><span>Oportunidades, etapas, asignación y SLA.</span></li> : null}
        {me.permissions.includes("quotes:read") ? <li className="card"><Link href="/sales">Ventas</Link><span>Cotizaciones con evidencia aprobada y ventas.</span></li> : null}
        {me.permissions.includes("analytics:read") ? <li className="card"><Link href="/analytics">Analítica</Link><span>Embudo, SLA, ventas y conciliación con definiciones.</span></li> : null}
        <li className="card"><Link href="/company">Empresa</Link><span>Perfil y sedes de tu organización.</span></li>
      </ul>
      <details className="card">
        <summary>Mis permisos</summary>
        <ul>{me.permissions.map((p) => <li key={p}><code>{p}</code></li>)}</ul>
      </details>
    </div>
  );
}

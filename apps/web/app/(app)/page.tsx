import Link from "next/link";
import { requireSession } from "../../lib/auth";
import { ROLE_LABELS, label } from "../../lib/format";

export default async function HomePage() {
  const { me } = await requireSession();
  return (
    <>
      <h1>Hola, {me.user.displayName}</h1>
      <p>Organización <strong>{me.organization.name}</strong> (<code>{me.organization.slug}</code>) · rol {label(ROLE_LABELS, me.role)}.</p>
      <ul className="cards">
        <li><Link href="/catalog">Catálogo</Link><span>Productos y servicios, versiones y aprobaciones.</span></li>
        <li><Link href="/pricing">Precios</Link><span>Listas de precios aprobadas e inmutables.</span></li>
        <li><Link href="/prospects">Prospectos</Link><span>Candidatos, procedencia y lista de no contactar.</span></li>
        <li><Link href="/scoring">Puntuación</Link><span>Modelo de reglas transparente y versionado.</span></li>
        {me.permissions.includes("leads:read") ? <li><Link href="/leads">Leads</Link><span>Creados por regla o intención; los revisa una persona.</span></li> : null}
        <li><Link href="/company">Empresa</Link><span>Perfil y sedes de tu organización.</span></li>
      </ul>
      <details>
        <summary>Mis permisos</summary>
        <ul>{me.permissions.map((p) => <li key={p}><code>{p}</code></li>)}</ul>
      </details>
    </>
  );
}

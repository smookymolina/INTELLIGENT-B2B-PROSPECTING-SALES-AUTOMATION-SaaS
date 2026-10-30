import Link from "next/link";
import type { ReactNode } from "react";
import type { MyOrganizationsDto } from "@prospecting/contracts";
import { api } from "../../lib/api";
import { requireSession } from "../../lib/auth";
import { ROLE_LABELS, label } from "../../lib/format";

export default async function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { me, token } = await requireSession();
  const orgs = await api<MyOrganizationsDto>("/me/organizations", { token });
  const others = orgs.ok ? orgs.data.items.filter((o) => !o.current) : [];
  return (
    <>
      <a className="skip" href="#content">Saltar al contenido</a>
      <header className="bar">
        <strong>{me.organization.name}</strong>
        {others.length > 0 ? (
          <form method="post" action="/actions/team/switch" className="switcher" aria-label="Cambiar de organización">
            <label className="sr" htmlFor="org-switch">Cambiar de organización</label>
            <select id="org-switch" name="organizationSlug" defaultValue={others[0]?.slug}>{others.map((o) => <option key={o.id} value={o.slug}>{o.name}</option>)}</select>
            <button type="submit">Cambiar</button>
          </form>
        ) : null}
        <nav aria-label="Principal">
          <Link href="/">Inicio</Link>
          <Link href="/catalog">Catálogo</Link>
          <Link href="/pricing">Precios</Link>
          <Link href="/prospects">Prospectos</Link>
          <Link href="/scoring">Puntuación</Link>
          {me.permissions.includes("leads:read") ? <Link href="/leads">Leads</Link> : null}
          {me.permissions.includes("crm:read") ? <Link href="/pipeline">Pipeline</Link> : null}
          {me.permissions.includes("quotes:read") ? <Link href="/sales">Ventas</Link> : null}
          {me.permissions.includes("analytics:read") ? <Link href="/analytics">Analítica</Link> : null}
          <Link href="/company">Empresa</Link>
          {me.permissions.includes("members:read") ? <Link href="/team">Equipo</Link> : null}
        </nav>
        <span className="who"><Link href="/account">{me.user.displayName}</Link> · {label(ROLE_LABELS, me.role)}</span>
        <form method="post" action="/session/logout"><button type="submit" className="link">Salir</button></form>
      </header>
      <main id="content">{children}</main>
    </>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";
import type { MyOrganizationsDto } from "@prospecting/contracts";
import { api } from "../../lib/api";
import { requireSession } from "../../lib/auth";
import { ROLE_LABELS, label } from "../../lib/format";
import { NavAdvanced } from "../components/nav-advanced";
import { NavLink } from "../components/nav-link";

type NavItem = { href: string; text: string; show: boolean };

export default async function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { me, token } = await requireSession();
  const orgs = await api<MyOrganizationsDto>("/me/organizations", { token });
  const others = orgs.ok ? orgs.data.items.filter((o) => !o.current) : [];
  const can = (permission: (typeof me.permissions)[number]) => me.permissions.includes(permission);
  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: "Prospección",
      items: [
        { href: "/prospects", text: "Prospectos", show: true },
        { href: "/leads", text: "Leads", show: can("leads:read") },
      ],
    },
    {
      title: "Alcance",
      items: [
        { href: "/drafts", text: "Borradores", show: can("campaigns:read") },
        { href: "/campaigns", text: "Campañas", show: can("campaigns:read") },
      ],
    },
    {
      title: "Ventas",
      items: [
        { href: "/pipeline", text: "Pipeline", show: can("crm:read") },
        { href: "/tasks", text: "Tareas", show: can("crm:read") },
        { href: "/sales", text: "Ventas", show: can("quotes:read") },
        { href: "/catalog", text: "Catálogo", show: true },
      ],
    },
    {
      title: "Negocio",
      items: [
        { href: "/company", text: "Empresa", show: true },
        { href: "/team", text: "Equipo", show: can("members:read") },
        { href: "/notifications-settings", text: "Notificaciones", show: can("organization:update") },
      ],
    },
  ];
  const advanced: NavItem[] = [
    { href: "/scoring", text: "Puntuación", show: true },
    { href: "/pricing", text: "Precios", show: true },
    { href: "/ai", text: "IA", show: can("ai:use") },
    { href: "/claude-usage", text: "Uso de Claude", show: can("ai:use") },
    { href: "/privacy", text: "Privacidad", show: can("privacy:manage") },
    { href: "/analytics", text: "Analítica", show: can("analytics:read") },
  ].filter((i) => i.show);
  return (
    <>
      <a className="skip" href="#content">Saltar al contenido</a>
      <div className="shell">
        <aside className="side">
          <p className="side-brand">{me.organization.name}</p>
          {others.length > 0 ? (
            <form method="post" action="/actions/team/switch" className="switcher" aria-label="Cambiar de negocio">
              <label className="sr" htmlFor="org-switch">Cambiar de negocio</label>
              <select id="org-switch" name="organizationSlug" defaultValue={others[0]?.slug}>{others.map((o) => <option key={o.id} value={o.slug}>{o.name}</option>)}</select>
              <button type="submit">Cambiar</button>
            </form>
          ) : null}
          <Link className="nav-add" href="/company/new">+ Nuevo negocio</Link>
          <nav aria-label="Principal">
            <div className="nav-group">
              <NavLink href="/">Inicio</NavLink>
            </div>
            {groups.map((g) => {
              const visible = g.items.filter((i) => i.show);
              if (visible.length === 0) return null;
              return (
                <div className="nav-group" key={g.title}>
                  <p className="nav-title">{g.title}</p>
                  {visible.map((i) => <NavLink key={i.href} href={i.href}>{i.text}</NavLink>)}
                </div>
              );
            })}
            {advanced.length > 0 ? (
              <NavAdvanced hrefs={advanced.map((i) => i.href)}>
                {advanced.map((i) => <NavLink key={i.href} href={i.href}>{i.text}</NavLink>)}
              </NavAdvanced>
            ) : null}
          </nav>
          <div className="side-foot">
            <span className="who"><Link href="/account">{me.user.displayName}</Link> · {label(ROLE_LABELS, me.role)}</span>
            <form method="post" action="/session/logout"><button type="submit" className="link">Salir</button></form>
          </div>
        </aside>
        <div className="shell-main">
          <main id="content">{children}</main>
        </div>
      </div>
    </>
  );
}

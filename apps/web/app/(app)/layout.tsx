import Link from "next/link";
import type { ReactNode } from "react";
import { requireSession } from "../../lib/auth";
import { ROLE_LABELS, label } from "../../lib/format";

export default async function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { me } = await requireSession();
  return (
    <>
      <a className="skip" href="#content">Saltar al contenido</a>
      <header className="bar">
        <strong>{me.organization.name}</strong>
        <nav aria-label="Principal">
          <Link href="/">Inicio</Link>
          <Link href="/catalog">Catálogo</Link>
          <Link href="/company">Empresa</Link>
        </nav>
        <span className="who">{me.user.displayName} · {label(ROLE_LABELS, me.role)}</span>
        <form method="post" action="/session/logout"><button type="submit" className="link">Salir</button></form>
      </header>
      <main id="content">{children}</main>
    </>
  );
}

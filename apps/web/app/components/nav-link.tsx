"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Enlace de navegación: marca la ruta activa con aria-current (exacta para "/", por segmento para el resto). */
export function NavLink({ href, children }: Readonly<{ href: string; children: ReactNode }>) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
  return <Link href={href} aria-current={active ? "page" : undefined}>{children}</Link>;
}

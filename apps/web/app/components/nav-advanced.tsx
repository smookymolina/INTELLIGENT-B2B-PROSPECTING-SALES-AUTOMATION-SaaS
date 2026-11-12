"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Grupo plegable «Avanzado»: cerrado por defecto y abierto cuando la ruta actual es una de sus entradas. */
export function NavAdvanced({ hrefs, children }: Readonly<{ hrefs: string[]; children: ReactNode }>) {
  const pathname = usePathname();
  const inside = hrefs.some((h) => pathname === h || pathname.startsWith(`${h}/`));
  return (
    <details className="nav-group nav-advanced" open={inside || undefined}>
      <summary className="nav-title">Avanzado</summary>
      {children}
    </details>
  );
}

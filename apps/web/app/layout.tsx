import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./styles.css";

export const metadata: Metadata = {
  title: "Intelligent B2B Prospecting",
  description: "B2B prospecting and sales automation platform"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="es-MX"><body>{children}</body></html>;
}

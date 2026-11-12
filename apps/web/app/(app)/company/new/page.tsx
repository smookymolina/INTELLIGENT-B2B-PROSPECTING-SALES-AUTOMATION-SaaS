import Link from "next/link";
import { requireSession } from "../../../../lib/auth";
import { Flash } from "../../../components/flash";

/** A user can manage several businesses; each one has its own SMTP account, configured right after creation. */
export default async function NewBusinessPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireSession();
  const sp = await searchParams;
  return (
    <>
      <header className="page-head">
        <h1>Nuevo negocio</h1>
      </header>
      <p><Link href="/company">← Empresa</Link></p>
      <Flash sp={sp} />
      <form method="post" action="/actions/business/create" className="stack" aria-label="Crear negocio">
        <p className="hint">Cada negocio tiene sus propios prospectos, campañas y cuenta de correo. Al crearlo pasarás a él y configurarás su SMTP.</p>
        <label>Nombre del negocio<input name="organizationName" required maxLength={120} autoComplete="organization" /></label>
        <button type="submit">Crear negocio</button>
      </form>
    </>
  );
}

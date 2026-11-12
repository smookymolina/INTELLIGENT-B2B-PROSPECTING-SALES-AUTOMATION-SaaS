import Link from "next/link";
import { requireSession } from "../../../../lib/auth";
import { Flash } from "../../../components/flash";

export default async function NewProspectPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { me } = await requireSession();
  const sp = await searchParams;
  if (!me.permissions.includes("prospects:manage")) return <p role="alert" className="notice error">Tu rol no permite crear prospectos.</p>;
  return (
    <>
      <p><Link href="/prospects">← Prospectos</Link></p>
      <header className="page-head">
        <h1>Nuevo prospecto</h1>
      </header>
      <Flash sp={sp} />
      <p className="hint">Se guarda como <strong>candidato</strong> con procedencia «manual». Si el dominio (o nombre + país) ya existe, te llevaremos al registro existente.</p>
      <form method="post" action="/actions/prospects/create">
        <label>Nombre de la empresa<input name="name" required maxLength={200} /></label>
        <label>Dominio o sitio web (opcional)<input name="domain" maxLength={300} placeholder="ejemplo.com" /></label>
        <label>País (código de 2 letras, opcional)<input name="country" maxLength={2} pattern="[A-Za-z]{2}" placeholder="MX" /></label>
        <label>Estado o región<input name="region" maxLength={100} /></label>
        <label>Ciudad<input name="city" maxLength={100} /></label>
        <label>Giro<input name="industry" maxLength={100} /></label>
        <label>Notas internas<textarea name="notes" rows={3} maxLength={2000} /></label>
        <button type="submit">Guardar candidato</button>
      </form>
    </>
  );
}

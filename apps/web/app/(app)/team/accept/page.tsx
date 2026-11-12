import Link from "next/link";
import { Flash } from "../../../components/flash";

export default async function AcceptInvitationPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <>
      <p><Link href="/team">← Equipo</Link></p>
      <header className="page-head">
        <h1>Aceptar una invitación</h1>
      </header>
      <Flash sp={sp} />
      <p className="hint">Pega el código que te entregó el administrador. Sólo funciona si la invitación fue emitida para el correo de tu cuenta. Después podrás cambiar de organización desde el encabezado.</p>
      <form method="post" action="/actions/team/accept" className="stack" aria-label="Aceptar invitación">
        <label>Código de invitación<input name="token" required minLength={43} maxLength={43} pattern="[A-Za-z0-9_\-]{43}" autoComplete="off" spellCheck={false} /></label>
        <button type="submit">Aceptar</button>
      </form>
    </>
  );
}

import type { EmailSettingsDto } from "@prospecting/contracts";
import Link from "next/link";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { formatDate } from "../../../../lib/format";
import { Flash } from "../../../components/flash";

/** Each organization sends with its own SMTP mailbox. The password is write-only: it is never sent back to the browser. */
export default async function EmailSettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  if (!me.permissions.includes("organization:update")) return <p role="alert" className="notice error">Tu rol no puede ver ni cambiar la configuración de correo.</p>;
  const res = await api<EmailSettingsDto>("/organization/email-settings", { token });
  if (!res.ok) throw new Error("The email settings could not be loaded");
  const s = res.data;
  return (
    <>
      <header className="page-head">
        <h1>Correo saliente (SMTP)</h1>
      </header>
      <p><Link href="/company">← Empresa</Link></p>
      <Flash sp={sp} />
      {s.configured ? (
        <p className="hint">
          {s.verifiedAt ? `Conexión verificada el ${formatDate(s.verifiedAt)}.` : "Guardado, pero la conexión aún no se ha verificado: usa «Probar conexión»."}
        </p>
      ) : (
        <p className="empty">Tu organización aún no tiene una cuenta de correo. Sin ella, las campañas y secuencias no envían nada.</p>
      )}

      <form method="post" action="/actions/company/email" className="stack" aria-label="Cuenta SMTP">
        <p className="hint">Usa los datos que te da tu proveedor de correo. El puerto 465 usa TLS directo; 587 y 25 usan STARTTLS obligatorio.</p>
        <label>Servidor SMTP<input name="host" required maxLength={253} autoComplete="off" spellCheck={false} defaultValue={s.host ?? ""} aria-describedby="host-hint" /></label>
        <p id="host-hint" className="hint">Formato: smtp.tudominio.com</p>
        <label>Puerto
          <select name="port" defaultValue={String(s.port ?? 465)}>
            <option value="465">465 (TLS directo)</option>
            <option value="587">587 (STARTTLS)</option>
            <option value="25">25 (STARTTLS)</option>
            <option value="2525">2525 (STARTTLS)</option>
          </select>
        </label>
        <label>Usuario<input name="username" required maxLength={254} autoComplete="off" spellCheck={false} defaultValue={s.username ?? ""} /></label>
        <label>Contraseña<input name="password" type="password" maxLength={256} autoComplete="new-password" required={!s.hasPassword} aria-describedby="password-hint" /></label>
        <p id="password-hint" className="hint">
          {s.hasPassword ? "Hay una contraseña guardada. Déjala vacía para conservarla; es obligatoria si cambias servidor, puerto o usuario." : "Se guarda cifrada y no se vuelve a mostrar."}
        </p>
        <label>Nombre del remitente (opcional)<input name="fromName" maxLength={120} defaultValue={s.fromName ?? ""} /></label>
        <label>Correo del remitente<input name="fromEmail" type="email" required maxLength={254} defaultValue={s.fromEmail ?? ""} /></label>
        <label>Responder a (opcional)<input name="replyTo" type="email" maxLength={254} defaultValue={s.replyTo ?? ""} /></label>
        <button type="submit">Guardar cuenta de correo</button>
      </form>

      {s.configured ? (
        <>
          <h2>Probar conexión</h2>
          <form method="post" action="/actions/company/email/test" className="stack" aria-label="Probar conexión SMTP">
            <label>Enviar un mensaje de prueba a (opcional)<input name="sendTo" type="email" maxLength={254} aria-describedby="test-hint" /></label>
            <p id="test-hint" className="hint">Si lo dejas vacío solo se comprueban la conexión y el inicio de sesión; no se envía nada.</p>
            <button type="submit">Probar conexión</button>
          </form>

          <h2>Quitar cuenta</h2>
          <form method="post" action="/actions/company/email/delete" className="stack" aria-label="Quitar cuenta SMTP">
            <p className="hint">Se borra la cuenta y su contraseña cifrada. Las campañas dejarán de enviar hasta que configures otra.</p>
            <label>Escribe QUITAR para confirmar<input name="confirm" required pattern="QUITAR" autoComplete="off" /></label>
            <button type="submit">Quitar cuenta de correo</button>
          </form>
        </>
      ) : null}
    </>
  );
}

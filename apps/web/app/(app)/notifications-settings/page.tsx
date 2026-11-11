import Link from "next/link";
import type { EmailSettingsDto, NotificationEmailDestinationsDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { formatDate } from "../../../lib/format";
import { EVENT_TYPE_LABELS, MAX_DESTINATIONS } from "../../../lib/notif";
import { Flash } from "../../components/flash";

/** Where notifications are e-mailed, and the SMTP account they leave from (separate from the account used for personalized outreach mail). */
export default async function NotificationsSettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  if (!me.permissions.includes("organization:update")) return <p role="alert" className="notice error">Solo un administrador puede ver y cambiar las notificaciones por correo.</p>;
  const [dest, smtp] = await Promise.all([
    api<NotificationEmailDestinationsDto>("/notifications/email-destinations", { token }),
    api<EmailSettingsDto>("/organization/email-settings?purpose=notifications", { token }),
  ]);
  if (!dest.ok || !smtp.ok) {
    return (
      <>
        <h1>Notificaciones</h1>
        <Flash sp={sp} />
        <p role="alert" className="notice error">No pudimos cargar la configuración. Recarga la página; si sigue igual, inténtalo en unos minutos.</p>
      </>
    );
  }
  const d = dest.data;
  const s = smtp.data;
  const slots = Array.from({ length: MAX_DESTINATIONS }, (_, i) => d.items[i]);
  return (
    <>
      <h1>Notificaciones</h1>
      <Flash sp={sp} />
      <p className="hint">Los correos personalizados a prospectos salen de una cuenta de envío; las notificaciones internas salen de otra. Se configuran por separado.</p>

      <h2>Dónde enviar las notificaciones (correo)</h2>
      {d.accountConfigured ? null : <p role="status" className="notice working"><strong>Falta la cuenta de envío de notificaciones.</strong> Mientras no la configures abajo, los correos esperan en cola.</p>}
      <form method="post" action="/actions/notifications-settings/destinations" className="stack" aria-label="Destinos de notificación">
        <p className="hint">Hasta {d.max} direcciones distintas. Deja en blanco las que no uses.</p>
        {slots.map((it, i) => (
          <label key={i}>Dirección {i + 1}<input name="address" type="email" maxLength={254} autoComplete="off" defaultValue={it?.address ?? ""} /></label>
        ))}
        <fieldset className="checks">
          <legend>Eventos que también se envían por correo</legend>
          {Object.entries(EVENT_TYPE_LABELS).map(([type, text]) => (
            <label key={type}><input type="checkbox" name="enabledType" value={type} defaultChecked={d.enabledTypes.includes(type as never)} /> {text}</label>
          ))}
        </fieldset>
        <button type="submit">Guardar destinos</button>
      </form>

      {d.items.length > 0 ? (
        <>
          <h3>Correo de prueba</h3>
          <ul>
            {d.items.map((it) => (
              <li key={it.id}>
                <form method="post" action={`/actions/notifications-settings/destinations/${it.id}/test`} aria-label={`Prueba a ${it.address}`}>
                  {it.address} · última prueba: {formatDate(it.lastTestAt)} <button type="submit">Enviar correo de prueba a {it.address}</button>
                </form>
              </li>
            ))}
          </ul>
        </>
      ) : <p className="empty">Aún no hay destinos. Agrega al menos una dirección arriba y guarda para poder enviar una prueba.</p>}

      <h2>Cuenta de envío de notificaciones</h2>
      <SmtpSection purpose="notifications" s={s} />

      <h2>Cuenta de envío de correos personalizados</h2>
      <p className="hint">Es la cuenta desde la que salen los mensajes a prospectos. Se administra en <Link href="/company/email">Correo saliente (SMTP)</Link>.</p>
    </>
  );
}

function SmtpSection({ purpose, s }: { purpose: "notifications"; s: EmailSettingsDto }) {
  return (
    <>
      <p className="hint">
        {s.configured
          ? s.verifiedAt ? `Cuenta configurada. Conexión verificada el ${formatDate(s.verifiedAt)}.` : "Cuenta configurada, aún sin verificar: usa «Probar conexión»."
          : "Aún no hay cuenta configurada."}
      </p>
      <form method="post" action="/actions/notifications-settings/smtp" className="stack" aria-label="Cuenta SMTP de notificaciones">
        <input type="hidden" name="purpose" value={purpose} />
        <label>Servidor SMTP<input name="host" required maxLength={253} autoComplete="off" spellCheck={false} defaultValue={s.host ?? ""} /></label>
        <label>Puerto
          <select name="port" defaultValue={String(s.port ?? 465)}>
            <option value="465">465 (TLS directo)</option>
            <option value="587">587 (STARTTLS)</option>
            <option value="25">25 (STARTTLS)</option>
            <option value="2525">2525 (STARTTLS)</option>
          </select>
        </label>
        <label>Usuario<input name="username" required maxLength={254} autoComplete="off" spellCheck={false} defaultValue={s.username ?? ""} /></label>
        <label>Contraseña<input name="password" type="password" maxLength={256} autoComplete="new-password" required={!s.hasPassword} aria-describedby="np-hint" /></label>
        <p id="np-hint" className="hint">{s.hasPassword ? "Contraseña configurada (no se muestra). Déjala vacía para conservarla; es obligatoria si cambias servidor, puerto o usuario." : "Se guarda cifrada y no se vuelve a mostrar."}</p>
        <label>Nombre del remitente (opcional)<input name="fromName" maxLength={120} defaultValue={s.fromName ?? ""} /></label>
        <label>Correo del remitente<input name="fromEmail" type="email" required maxLength={254} defaultValue={s.fromEmail ?? ""} /></label>
        <button type="submit">Guardar cuenta de notificaciones</button>
      </form>
      {s.configured ? (
        <>
          <form method="post" action="/actions/notifications-settings/smtp/test" aria-label="Probar conexión de notificaciones" className="stack">
            <input type="hidden" name="purpose" value={purpose} />
            <button type="submit">Probar conexión</button>
          </form>
          <form method="post" action="/actions/notifications-settings/smtp/delete" aria-label="Quitar cuenta de notificaciones" className="stack">
            <input type="hidden" name="purpose" value={purpose} />
            <label>Escribe QUITAR para confirmar<input name="confirm" required pattern="QUITAR" autoComplete="off" /></label>
            <button type="submit">Quitar cuenta de notificaciones</button>
          </form>
        </>
      ) : null}
    </>
  );
}

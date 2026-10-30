import type { SessionInfoListDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { formatDate } from "../../../lib/format";
import { Flash } from "../../components/flash";

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  const sessions = await api<SessionInfoListDto>("/auth/sessions", { token });
  if (!sessions.ok) throw new Error("The sessions could not be loaded");
  return (
    <>
      <h1>Mi cuenta</h1>
      <Flash sp={sp} />
      <p>{me.user.displayName} · {me.user.email}</p>
      <h2>Cambiar contraseña</h2>
      <p className="hint">Al cambiarla se cierran todas tus demás sesiones en todas tus organizaciones. Mínimo 12 caracteres.</p>
      <form method="post" action="/actions/account/password" aria-label="Cambiar contraseña">
        <label>Contraseña actual<input name="currentPassword" type="password" required maxLength={128} autoComplete="current-password" /></label>
        <label>Contraseña nueva<input name="newPassword" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label>
        <label>Confirmar contraseña nueva<input name="confirmPassword" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label>
        <button type="submit">Cambiar contraseña</button>
      </form>
      <h2>Sesiones activas en esta organización</h2>
      <div className="table-wrap">
        <table>
          <caption className="sr">Sesiones activas</caption>
          <thead><tr><th scope="col">Iniciada</th><th scope="col">Vence</th><th scope="col">Acciones</th></tr></thead>
          <tbody>
            {sessions.data.items.map((s) => (
              <tr key={s.id}>
                <td>{formatDate(s.createdAt)}{s.current ? " (esta sesión)" : ""}</td><td>{formatDate(s.expiresAt)}</td>
                <td>{s.current ? "—" : <form method="post" action={`/actions/account/session/${s.id}`}><button type="submit">Cerrar</button></form>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

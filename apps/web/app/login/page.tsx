import Link from "next/link";
import { redirect } from "next/navigation";
import { readSessionToken } from "../../lib/session";

const MESSAGES: Record<string, string> = {
  invalid: "Credenciales inválidas o sin acceso a la organización indicada.",
  expired: "Tu sesión expiró. Inicia sesión de nuevo.",
  rate: "Demasiados intentos. Espera unos minutos antes de volver a intentar.",
  input: "Revisa los datos ingresados.",
  unavailable: "El servicio no está disponible. Intenta más tarde.",
  unexpected: "No fue posible iniciar sesión.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await readSessionToken()) redirect("/");
  const { error } = await searchParams;
  const message = error ? (MESSAGES[error] ?? MESSAGES.unexpected) : null;
  return (
    <main className="auth">
      <h1>Iniciar sesión</h1>
      {message ? <p role="alert" className="notice error">{message}</p> : null}
      <form method="post" action="/session/login">
        <label>Correo electrónico<input name="email" type="email" autoComplete="username" required maxLength={254} /></label>
        <label>Contraseña<input name="password" type="password" autoComplete="current-password" required maxLength={128} /></label>
        <label>Organización (opcional)<input name="organizationSlug" type="text" autoComplete="off" maxLength={64} placeholder="identificador de la organización" /></label>
        <button type="submit">Entrar</button>
      </form>
      <p>¿Primera vez? <Link href="/register">Crear una cuenta y organización</Link></p>
    </main>
  );
}

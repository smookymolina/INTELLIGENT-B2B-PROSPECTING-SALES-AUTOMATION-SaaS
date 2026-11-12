import { randomUUID } from "node:crypto";
import Link from "next/link";
import { redirect } from "next/navigation";
import { readSessionToken } from "../../lib/session";
import { AuthBrand } from "../components/auth-brand";

const MESSAGES: Record<string, string> = {
  input: "Revisa los datos: la contraseña necesita al menos 12 caracteres y el correo debe ser válido.",
  conflict: "No fue posible registrar con esos datos.",
  rate: "Demasiados intentos. Espera unos minutos antes de volver a intentar.",
  unavailable: "El servicio no está disponible. Intenta más tarde.",
  unexpected: "No fue posible completar el registro.",
};

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await readSessionToken()) redirect("/");
  const { error } = await searchParams;
  const message = error ? (MESSAGES[error] ?? MESSAGES.unexpected) : null;
  return (
    <div className="auth-wrap">
      <AuthBrand />
      <main className="auth">
        <h1>Crear cuenta</h1>
        {message ? <p role="alert" className="notice error">{message}</p> : null}
        <form method="post" action="/session/register">
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <label>Tu nombre<input name="displayName" type="text" autoComplete="name" required maxLength={100} /></label>
          <label>Correo electrónico<input name="email" type="email" autoComplete="username" required maxLength={254} /></label>
          <label>Contraseña (mínimo 12 caracteres)<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label>
          <label>Nombre de tu organización<input name="organizationName" type="text" autoComplete="organization" required minLength={2} maxLength={100} /></label>
          <button type="submit">Crear cuenta</button>
        </form>
        <p>¿Ya tienes cuenta? <Link href="/login">Iniciar sesión</Link></p>
      </main>
    </div>
  );
}

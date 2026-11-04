import Link from "next/link";

/** Root 404 (rutas sin coincidencia): usa el layout raíz, así que conserva lang y aporta main + h1. */
export default function NotFound() {
  return (
    <main className="auth">
      <h1>Página no encontrada</h1>
      <p>El recurso que buscas no existe o ya no está disponible.</p>
      <p><Link href="/">Ir al inicio</Link></p>
    </main>
  );
}

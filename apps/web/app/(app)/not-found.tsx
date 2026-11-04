import Link from "next/link";

/** 404 dentro del área autenticada: ya hay <main> en el layout, solo aporta h1 y salida. */
export default function NotFound() {
  return (
    <>
      <h1>No encontrado</h1>
      <p>El registro que buscas no existe o no tienes acceso a él.</p>
      <p><Link href="/">Ir al inicio</Link></p>
    </>
  );
}

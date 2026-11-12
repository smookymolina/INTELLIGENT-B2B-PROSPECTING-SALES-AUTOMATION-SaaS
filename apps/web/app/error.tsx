"use client";

/** Generic boundary: never shows internals (the server log has the detail). */
export default function ErrorBoundary({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="auth">
      <div className="card stack">
        <h1>Algo salió mal</h1>
        <p role="alert">No pudimos completar la operación. Intenta de nuevo; si persiste, contacta a soporte.</p>
        <button type="button" onClick={reset}>Reintentar</button>
      </div>
    </main>
  );
}

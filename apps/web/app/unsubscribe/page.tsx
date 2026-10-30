import { Flash } from "../components/flash";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Public page (no session). The signed link only pre-fills hidden fields; nothing happens until the person presses the button (mail scanners that open links do not unsubscribe anyone). */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ o?: string; c?: string; s?: string; ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const valid = !!sp.o && !!sp.c && !!sp.s && UUID.test(sp.o) && UUID.test(sp.c) && /^[0-9a-f]{64}$/.test(sp.s);
  return (
    <main id="content" style={{ maxWidth: "36rem", margin: "2rem auto", padding: "0 1rem" }}>
      <h1>Darte de baja</h1>
      <Flash sp={sp} />
      {sp.ok ? null : valid ? (
        <form method="post" action="/actions/public/unsubscribe">
          <input type="hidden" name="o" value={sp.o} />
          <input type="hidden" name="c" value={sp.c} />
          <input type="hidden" name="s" value={sp.s} />
          <p>Confirma que no quieres recibir más mensajes comerciales de esta organización.</p>
          <button type="submit">Confirmar baja</button>
        </form>
      ) : <p role="alert" className="notice error">El enlace no es válido. Responde al mensaje original pidiendo la baja.</p>}
    </main>
  );
}

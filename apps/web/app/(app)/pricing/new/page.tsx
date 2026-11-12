import Link from "next/link";
import { requireSession } from "../../../../lib/auth";
import { Flash } from "../../../components/flash";

export default async function NewPriceListPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { me } = await requireSession();
  const sp = await searchParams;
  if (!me.permissions.includes("catalog:manage")) return <p role="alert" className="notice error">Tu rol no permite crear listas de precios.</p>;
  return (
    <>
      <p><Link href="/pricing">← Listas de precios</Link></p>
      <header className="page-head">
        <h1>Nueva lista de precios</h1>
      </header>
      <Flash sp={sp} />
      <p className="hint">La <strong>moneda no se puede cambiar</strong> después de crear la lista.</p>
      <form method="post" action="/actions/pricing/create">
        <label>Nombre<input name="name" required maxLength={120} /></label>
        <label>Moneda (código ISO 4217, p. ej. MXN, USD)<input name="currency" required minLength={3} maxLength={3} pattern="[A-Za-z]{3}" /></label>
        <label>Vigente desde (opcional)<input name="validFrom" type="date" /></label>
        <label>Vigente hasta (opcional)<input name="validUntil" type="date" /></label>
        <button type="submit">Crear borrador</button>
      </form>
    </>
  );
}

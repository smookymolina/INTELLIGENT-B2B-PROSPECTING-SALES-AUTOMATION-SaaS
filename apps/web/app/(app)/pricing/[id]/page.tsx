import Link from "next/link";
import { notFound } from "next/navigation";
import type { ApprovedPricePageDto, ItemPageDto, PriceEntryPageDto, PriceListDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { STATUS_LABELS, formatDate, label } from "../../../../lib/format";
import { Flash } from "../../../components/flash";

function Op({ id, op, children, secondary }: { id: string; op: string; children: string; secondary?: boolean }) {
  return <form method="post" action={`/actions/pricing/${id}/${op}`} className="inline-form"><button type="submit" className={secondary ? "secondary" : undefined}>{children}</button></form>;
}

export default async function PriceListPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const list = await api<PriceListDto>(`/catalog/price-lists/${id}`, { token });
  if (!list.ok && (list.status === 404 || list.status === 400)) notFound();
  if (!list.ok) throw new Error("The price list could not be loaded");
  const l = list.data;
  const can = (p: string) => (me.permissions as readonly string[]).includes(p);
  const draft = l.status === "draft";
  const [entries, consumable, items] = await Promise.all([
    api<PriceEntryPageDto>(`/catalog/price-lists/${id}/entries?limit=100`, { token }),
    l.status === "approved" ? api<ApprovedPricePageDto>(`/catalog/price-lists/${id}/approved-prices?limit=100`, { token }) : Promise.resolve(null),
    draft && can("catalog:manage") ? api<ItemPageDto>("/catalog/items?limit=100", { token }) : Promise.resolve(null),
  ]);
  if (!entries.ok) throw new Error("Prices could not be loaded");
  const consumableIds = new Set(consumable?.ok ? consumable.data.items.map((i) => i.itemId) : []);
  return (
    <>
      <p><Link href="/pricing">← Listas de precios</Link></p>
      <header className="page-head">
        <h1>{l.name} <span className={`badge ${l.status}`}>{label(STATUS_LABELS, l.status)}</span></h1>
      </header>
      <Flash sp={sp} />
      <p>Moneda <strong>{l.currency}</strong> · vigencia {l.validFrom ?? "—"} → {l.validUntil ?? "—"} · {l.entryCount} precio(s){l.approvedAt ? ` · aprobada ${formatDate(l.approvedAt)}` : ""}{l.clonedFrom ? " · clon de otra lista" : ""}</p>
      <div className="actions" role="group" aria-label="Acciones">
        {can("catalog:approve") && draft ? <Op id={l.id} op="approve">Aprobar lista</Op> : null}
        {can("catalog:approve") && l.status !== "archived" ? <Op id={l.id} op="archive" secondary>Archivar</Op> : null}
      </div>
      {can("catalog:manage") ? (
        <form method="post" action={`/actions/pricing/${l.id}/clone`} className="inline">
          <label>Clonar como borrador (nombre nuevo)<input name="name" required maxLength={120} /></label>
          <button type="submit" className="secondary">Clonar</button>
        </form>
      ) : null}

      <h2>Precios</h2>
      {entries.data.items.length === 0 ? <p className="empty">Sin precios todavía.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr">Precios de la lista</caption>
            <thead><tr><th scope="col">SKU</th><th scope="col">Precio unitario ({l.currency})</th>{l.status === "approved" ? <th scope="col">Vigente para consumo</th> : null}{draft && can("catalog:manage") ? <th scope="col">Acciones</th> : null}</tr></thead>
            <tbody>
              {entries.data.items.map((e) => (
                <tr key={e.id}>
                  <td>{e.sku}</td><td>{e.unitPrice}</td>
                  {l.status === "approved" ? <td>{consumableIds.has(e.itemId) ? "Sí" : "No (ítem no aprobado o archivado)"}</td> : null}
                  {draft && can("catalog:manage") ? (
                    <td><form method="post" action={`/actions/pricing/${l.id}/unprice`} className="inline-form"><input type="hidden" name="itemId" value={e.itemId} /><button type="submit" className="secondary">Quitar</button></form></td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {draft && can("catalog:manage") && items?.ok ? (
        <form method="post" action={`/actions/pricing/${l.id}/price`} className="inline">
          <label>Elemento
            <select name="itemId" required>{items.data.items.filter((i) => i.status !== "archived").map((i) => <option key={i.id} value={i.id}>{i.sku} — {i.approved?.name ?? i.draft?.name ?? ""}{i.status === "draft" ? " (borrador)" : ""}</option>)}</select>
          </label>
          <label>Precio unitario (texto decimal, hasta 4 decimales)<input name="unitPrice" required inputMode="decimal" pattern="[0-9]{1,14}(\.[0-9]{1,4})?" placeholder="120.50" /></label>
          <button type="submit">Guardar precio</button>
        </form>
      ) : null}
      {draft && can("catalog:manage") ? (
        <section aria-labelledby="edit">
          <h2 id="edit">Editar lista</h2>
          <form method="post" action={`/actions/pricing/${l.id}/update`}>
            <label>Nombre<input name="name" required maxLength={120} defaultValue={l.name} /></label>
            <label>Vigente desde<input name="validFrom" type="date" defaultValue={l.validFrom ?? ""} /></label>
            <label>Vigente hasta<input name="validUntil" type="date" defaultValue={l.validUntil ?? ""} /></label>
            <button type="submit">Guardar cambios</button>
          </form>
        </section>
      ) : null}
    </>
  );
}

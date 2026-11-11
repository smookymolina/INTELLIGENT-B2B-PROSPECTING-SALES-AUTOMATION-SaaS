import Link from "next/link";
import { notFound } from "next/navigation";
import type { CategoryDto, ItemDto, ItemVersionDto } from "@prospecting/contracts";
import { featuresToText } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { KIND_LABELS, STATUS_LABELS, formatDate, label } from "../../../../lib/format";
import { Flash } from "../../../components/flash";
import { WorkingNotice } from "../../../components/working-notice";

function Version({ title, v }: { title: string; v: ItemVersionDto | null }) {
  return (
    <section aria-labelledby={`h-${title}`}>
      <h2 id={`h-${title}`}>{title}</h2>
      {!v ? <p className="empty">Sin contenido.</p> : (
        <dl>
          <dt>Versión</dt><dd>{v.version} · {label(STATUS_LABELS, v.state)}</dd>
          <dt>Nombre</dt><dd>{v.name}</dd>
          <dt>Descripción</dt><dd>{v.description ?? "—"}</dd>
          <dt>Unidad</dt><dd>{v.unit ?? "—"}</dd>
          <dt>Características</dt>
          <dd>{v.features.length ? <ul>{v.features.map((f) => <li key={f.name}><strong>{f.name}:</strong> {f.value}</li>)}</ul> : "—"}</dd>
          <dt>Aprobada</dt><dd>{formatDate(v.approvedAt)}</dd>
        </dl>
      )}
    </section>
  );
}

function Action({ id, op, children, danger }: { id: string; op: string; children: string; danger?: boolean }) {
  return <form method="post" action={`/actions/catalog/${id}/${op}`} className="inline-form"><button type="submit" className={danger ? "secondary" : undefined}>{children}</button></form>;
}

export default async function ItemPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [item, versions, categories] = await Promise.all([
    api<ItemDto>(`/catalog/items/${id}`, { token }),
    api<ItemVersionDto[]>(`/catalog/items/${id}/versions`, { token }),
    api<CategoryDto[]>("/catalog/categories", { token }),
  ]);
  if (!item.ok && (item.status === 404 || item.status === 400)) notFound();
  if (!item.ok || !versions.ok) throw new Error("The item could not be loaded");
  const i = item.data;
  const can = (p: string) => (me.permissions as readonly string[]).includes(p);
  const archived = i.status === "archived";
  const active = categories.ok ? categories.data.filter((c) => c.status === "active" || c.id === i.draft?.categoryId) : [];
  return (
    <>
      <p><Link href="/catalog">← Catálogo</Link></p>
      <h1>{i.sku} <span className={`badge ${i.status}`}>{label(STATUS_LABELS, i.status)}</span></h1>
      <p>{label(KIND_LABELS, i.kind)} · última versión {i.latestVersion}{i.archivedAt ? ` · archivado ${formatDate(i.archivedAt)}` : ""}</p>
      <Flash sp={sp} />
      <WorkingNotice what="Adjuntos, pagos y firma" />
      <div className="actions" role="group" aria-label="Acciones">
        {can("catalog:manage") && !archived && !i.draft ? <Action id={i.id} op="draft">Nueva versión (borrador)</Action> : null}
        {can("catalog:approve") && !archived && i.draft ? <Action id={i.id} op="approve">Aprobar borrador</Action> : null}
        {can("catalog:approve") && !archived ? <Action id={i.id} op="archive" danger>Archivar</Action> : null}
        {can("catalog:approve") && archived ? <Action id={i.id} op="restore">Restaurar</Action> : null}
      </div>
      <div className="two">
        <Version title="Contenido aprobado (el único que usan cotizaciones e IA)" v={i.approved} />
        <Version title="Borrador abierto" v={i.draft} />
      </div>
      {can("catalog:manage") && i.draft && !archived ? (
        <section aria-labelledby="edit">
          <h2 id="edit">Editar borrador (versión {i.draft.version})</h2>
          <form method="post" action={`/actions/catalog/${i.id}/update`}>
            <label>Nombre<input name="name" required maxLength={200} defaultValue={i.draft.name} /></label>
            <label>Descripción<textarea name="description" rows={3} maxLength={4000} defaultValue={i.draft.description ?? ""} /></label>
            <label>Unidad<input name="unit" maxLength={30} defaultValue={i.draft.unit ?? ""} /></label>
            <label>Categoría<select name="categoryId" defaultValue={i.draft.categoryId ?? ""}><option value="">Sin categoría</option>{active.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label>Características (una por línea, «Nombre: valor»)<textarea name="features" rows={4} maxLength={6000} defaultValue={featuresToText(i.draft.features)} /></label>
            <button type="submit">Guardar cambios</button>
          </form>
        </section>
      ) : null}
      <h2>Historial de versiones</h2>
      <div className="table-wrap">
        <table>
          <caption className="sr">Versiones</caption>
          <thead><tr><th scope="col">Versión</th><th scope="col">Estado</th><th scope="col">Nombre</th><th scope="col">Creada</th><th scope="col">Aprobada</th></tr></thead>
          <tbody>{versions.data.map((v) => <tr key={v.id}><td>{v.version}</td><td>{label(STATUS_LABELS, v.state)}</td><td>{v.name}</td><td>{formatDate(v.createdAt)}</td><td>{formatDate(v.approvedAt)}</td></tr>)}</tbody>
        </table>
      </div>
    </>
  );
}

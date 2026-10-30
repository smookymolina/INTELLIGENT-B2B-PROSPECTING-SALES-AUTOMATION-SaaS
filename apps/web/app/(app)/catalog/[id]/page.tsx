import Link from "next/link";
import { notFound } from "next/navigation";
import type { ItemDto, ItemVersionDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { KIND_LABELS, STATUS_LABELS, formatDate, label } from "../../../../lib/format";

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

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { token } = await requireSession();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [item, versions] = await Promise.all([api<ItemDto>(`/catalog/items/${id}`, { token }), api<ItemVersionDto[]>(`/catalog/items/${id}/versions`, { token })]);
  if (!item.ok && (item.status === 404 || item.status === 400)) notFound();
  if (!item.ok || !versions.ok) throw new Error("The item could not be loaded");
  const i = item.data;
  return (
    <>
      <p><Link href="/catalog">← Catálogo</Link></p>
      <h1>{i.sku} <span className={`badge ${i.status}`}>{label(STATUS_LABELS, i.status)}</span></h1>
      <p>{label(KIND_LABELS, i.kind)} · última versión {i.latestVersion}{i.archivedAt ? ` · archivado ${formatDate(i.archivedAt)}` : ""}</p>
      <div className="two">
        <Version title="Contenido aprobado (el único que usan cotizaciones e IA)" v={i.approved} />
        <Version title="Borrador abierto" v={i.draft} />
      </div>
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

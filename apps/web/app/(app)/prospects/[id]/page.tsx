import Link from "next/link";
import { notFound } from "next/navigation";
import type { ProspectDetailDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { formatDate } from "../../../../lib/format";
import { Flash } from "../../../components/flash";

const LABELS: Record<string, string> = { candidate: "Candidato", qualified: "Calificado", disqualified: "Descalificado" };
const SOURCE: Record<string, string> = { manual: "Captura manual", csv_import: "Importación CSV" };

export default async function ProspectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const result = await api<ProspectDetailDto>(`/prospects/${id}`, { token });
  if (!result.ok && (result.status === 404 || result.status === 400)) notFound();
  if (!result.ok) throw new Error("The prospect could not be loaded");
  const p = result.data;
  const manage = me.permissions.includes("prospects:manage");
  return (
    <>
      <p><Link href="/prospects">← Prospectos</Link></p>
      <h1>{p.name} <span className={`badge ${p.status === "qualified" ? "approved" : p.status === "candidate" ? "draft" : "archived"}`}>{LABELS[p.status]}</span></h1>
      <Flash sp={sp} />
      {p.suppressed ? <p role="alert" className="notice error">Está en la lista de no contactar: no puede calificarse ni usarse en campañas.</p> : null}
      <p className="hint">Permiso de contacto: <strong>ninguno</strong>. Calificar un prospecto no concede permiso para contactarlo.</p>
      <dl>
        <div className="row"><dt>Dominio</dt><dd>{p.domain ?? "—"}</dd></div>
        <div className="row"><dt>País / región / ciudad</dt><dd>{[p.country, p.region, p.city].filter(Boolean).join(" · ") || "—"}</dd></div>
        <div className="row"><dt>Giro</dt><dd>{p.industry ?? "—"}</dd></div>
        <div className="row"><dt>Notas</dt><dd>{p.notes ?? "—"}</dd></div>
        <div className="row"><dt>Motivo de estado</dt><dd>{p.statusReason ?? "—"}</dd></div>
      </dl>
      <h2>Procedencia</h2>
      <div className="table-wrap">
        <table>
          <caption className="sr">Procedencia</caption>
          <thead><tr><th scope="col">Origen</th><th scope="col">Referencia</th><th scope="col">Fecha</th></tr></thead>
          <tbody>{p.sources.map((s) => <tr key={s.id}><td>{SOURCE[s.type] ?? s.type}</td><td>{s.ref ? <code>{s.ref.slice(0, 8)}…</code> : "—"}</td><td>{formatDate(s.collectedAt)}</td></tr>)}</tbody>
        </table>
      </div>
      {manage ? (
        <>
          <h2>Estado</h2>
          <form method="post" action={`/actions/prospects/${p.id}/status`} className="inline">
            <label>Nuevo estado
              <select name="status" defaultValue={p.status}><option value="candidate">Candidato</option><option value="qualified">Calificado</option><option value="disqualified">Descalificado</option></select>
            </label>
            <label>Motivo (si se descalifica)<input name="reason" maxLength={200} /></label>
            <button type="submit">Cambiar estado</button>
          </form>
          <h2>Editar</h2>
          <form method="post" action={`/actions/prospects/${p.id}/update`}>
            <label>Nombre<input name="name" required maxLength={200} defaultValue={p.name} /></label>
            <label>Dominio<input name="domain" maxLength={300} defaultValue={p.domain ?? ""} /></label>
            <label>País (2 letras)<input name="country" maxLength={2} pattern="[A-Za-z]{2}" defaultValue={p.country ?? ""} /></label>
            <label>Estado o región<input name="region" maxLength={100} defaultValue={p.region ?? ""} /></label>
            <label>Ciudad<input name="city" maxLength={100} defaultValue={p.city ?? ""} /></label>
            <label>Giro<input name="industry" maxLength={100} defaultValue={p.industry ?? ""} /></label>
            <label>Notas internas<textarea name="notes" rows={3} maxLength={2000} defaultValue={p.notes ?? ""} /></label>
            <button type="submit">Guardar cambios</button>
          </form>
        </>
      ) : null}
    </>
  );
}

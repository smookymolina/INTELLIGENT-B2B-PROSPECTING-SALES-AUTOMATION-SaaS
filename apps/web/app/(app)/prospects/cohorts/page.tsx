import Link from "next/link";
import type { CohortListDto, LeadQuotaDto } from "@prospecting/contracts";
import { api } from "../../../../lib/api";
import { requireSession } from "../../../../lib/auth";
import { formatPercent } from "../../../../lib/notif";
import { Flash } from "../../../components/flash";

/** Prospects grouped by the month they were discovered, with how each ended up. */
export default async function CohortsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  const [res, quota] = await Promise.all([api<CohortListDto>("/prospects/cohorts", { token }), api<LeadQuotaDto>("/prospects/lead-quota", { token })]);
  const canEdit = me.permissions.includes("organization:update");
  return (
    <>
      <h1>Cohortes de prospectos</h1>
      <p><Link href="/prospects">← Prospectos</Link></p>
      <Flash sp={sp} />
      <p className="hint">Regla de vida: un prospecto se conserva hasta que se vuelve lead, el lead lo rechaza o no responde, o pasa un mes.</p>
      {!res.ok ? (
        <p role="alert" className="notice error">{res.status === 403 ? "Tu rol no puede ver las cohortes." : "No pudimos cargar las cohortes. Recarga la página; si sigue igual, inténtalo en unos minutos."}</p>
      ) : res.data.items.length === 0 ? (
        <p className="empty">Todavía no hay prospectos descubiertos. Cuando los haya, aquí verás cada mes.</p>
      ) : (
        <table>
          <caption>Prospectos por mes de descubrimiento</caption>
          <thead>
            <tr>
              <th scope="col">Mes</th><th scope="col">Descubiertos</th><th scope="col">Activos</th><th scope="col">Convertidos</th>
              <th scope="col">Rechazados</th><th scope="col">Sin respuesta</th><th scope="col">Expirados</th><th scope="col">Cupo mensual</th><th scope="col">Cupo usado</th>
            </tr>
          </thead>
          <tbody>
            {res.data.items.map((c) => (
              <tr key={c.month}>
                <th scope="row">{c.month}</th><td>{c.discovered}</td><td>{c.active}</td><td>{c.converted}</td><td>{c.rejected}</td><td>{c.noReply}</td><td>{c.expired}</td>
                <td>{c.monthlyLeadQuota ?? "sin cupo"}</td><td>{formatPercent(c.quotaUsedPercent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canEdit ? (
        <form method="post" action="/actions/prospects/lead-quota" className="stack" aria-label="Cupo mensual de leads">
          <label>Cupo mensual de leads<input name="monthlyLeadQuota" type="number" inputMode="numeric" min={0} max={1000000} step={1} required defaultValue={quota.ok ? (quota.data.monthlyLeadQuota ?? 0) : 0} aria-describedby="quota-hint" /></label>
          <p id="quota-hint" className="hint">0 significa sin cupo.</p>
          <button type="submit">Guardar cupo</button>
        </form>
      ) : null}
    </>
  );
}

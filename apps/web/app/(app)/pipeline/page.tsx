import Link from "next/link";
import { OPPORTUNITY_STAGES, type OpportunityPageDto, type PipelineSummaryDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { STAGE_LABELS, pick } from "../../../lib/format";
import { Flash } from "../../components/flash";

const OWNERS = ["me", "unassigned"] as const;

export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ owner?: string; ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  const owner = pick(sp.owner, OWNERS);
  const can = (p: string) => (me.permissions as readonly string[]).includes(p);
  const [list, summary] = await Promise.all([
    api<OpportunityPageDto>(`/opportunities?limit=100${owner ? `&owner=${owner}` : ""}`, { token }),
    api<PipelineSummaryDto>("/opportunities/summary", { token }),
  ]);
  if (!list.ok || !summary.ok) throw new Error("The pipeline could not be loaded");
  const isSeller = me.role === "seller";
  return (
    <>
      <header className="page-head">
        <h1>Pipeline</h1>
      </header>
      <Flash sp={sp} />
      <p className="hint">{isSeller ? "Sólo ves las oportunidades que te asignaron." : "Todas las oportunidades de tu organización."} Se crean a partir de leads aceptados (desde <Link href="/leads">Leads</Link>).</p>
      <p className="toolbar">
        <Link href="/sales">Ventas y cotizaciones</Link>
        {can("crm:manage") ? <Link href="/pipeline/routing">Asignación</Link> : null}
      </p>
      <form method="get" className="filters" aria-label="Filtros">
        <label>Responsable<select name="owner" defaultValue={owner ?? ""}><option value="">Todos</option><option value="me">Mis oportunidades</option>{!isSeller ? <option value="unassigned">Sin asignar</option> : null}</select></label>
        <button type="submit">Filtrar</button>
      </form>
      <p>Total: <strong>{summary.data.total}</strong></p>
      <div className="board" role="region" aria-label="Tablero del pipeline" tabIndex={0}>
        {OPPORTUNITY_STAGES.map((stage) => {
          const items = list.data.items.filter((o) => o.stage === stage);
          return (
            <section key={stage} aria-labelledby={`c-${stage}`} className="column">
              <h2 id={`c-${stage}`}>{STAGE_LABELS[stage]} <span className="hint">({summary.data.stages[stage] ?? 0})</span></h2>
              {items.length === 0 ? <p className="empty">—</p> : (
                <ul>
                  {items.map((o) => (
                    <li key={o.id}>
                      <Link href={`/pipeline/${o.id}`}>{o.title}</Link>
                      <span className="hint">{o.prospect.name}{o.ownerName ? ` · ${o.ownerName}` : " · sin asignar"}</span>
                      {o.slaBreached ? <span className="badge archived">SLA vencido</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

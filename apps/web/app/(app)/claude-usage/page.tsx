import type { AiUsageSummaryDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { requireSession } from "../../../lib/auth";
import { barValue, formatMicros, formatPercent, usageText } from "../../../lib/notif";
import { Flash } from "../../components/flash";

/** Monthly Claude usage as the SaaS can see it: internal MCP calls and API AI spend. The Claude plan percentage is not visible here. */
export default async function ClaudeUsagePage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { token, me } = await requireSession();
  const sp = await searchParams;
  const res = await api<AiUsageSummaryDto>("/ai/usage-summary", { token });
  const canEdit = me.permissions.includes("organization:update");
  if (!res.ok) {
    return (
      <>
        <h1>Uso de Claude</h1>
        <Flash sp={sp} />
        <p role="alert" className="notice error">{res.status === 403 ? "Tu rol no puede ver el uso de Claude." : "No pudimos cargar el uso. Recarga la página; si sigue igual, inténtalo en unos minutos."}</p>
      </>
    );
  }
  const u = res.data;
  const { mcp, api: ai } = u;
  const limit = mcp.monthlyLimit > 0 ? mcp.monthlyLimit : null;
  const mcpText = usageText(mcp.calls, limit, mcp.percentUsed);
  const aiPercent = ai.percentUsed;
  const aiText = ai.monthlyLimitMicros
    ? `${formatMicros(ai.spentMicros)} de ${formatMicros(ai.monthlyLimitMicros)} · ${formatPercent(aiPercent)}`
    : `${formatMicros(ai.spentMicros)} · sin presupuesto definido`;
  return (
    <>
      <h1>Uso de Claude</h1>
      <Flash sp={sp} />
      <p role="status" className="notice working"><strong>{u.claudePlanNotice}.</strong> Consúltalo directamente en <a href="https://claude.ai" target="_blank" rel="noopener noreferrer">claude.ai (se abre en otra pestaña)</a>.</p>

      <h2>Llamadas MCP del mes</h2>
      <p id="mcp-bar-label">Uso del límite interno de llamadas</p>
      <progress className="usage-bar" aria-labelledby="mcp-bar-label" aria-valuetext={mcpText} value={barValue(mcp.percentUsed)} max={100} />
      <p>{mcpText}</p>
      {mcp.byTool.length === 0 ? <p className="empty">Este mes todavía no hay llamadas MCP.</p> : (
        <table>
          <caption>Llamadas por herramienta</caption>
          <thead><tr><th scope="col">Herramienta</th><th scope="col">Llamadas</th><th scope="col">Errores</th></tr></thead>
          <tbody>{mcp.byTool.map((t) => <tr key={t.tool}><th scope="row">{t.tool}</th><td>{t.calls}</td><td>{t.errors}</td></tr>)}</tbody>
        </table>
      )}
      {mcp.daily.length > 0 ? (
        <table>
          <caption>Llamadas por día</caption>
          <thead><tr><th scope="col">Día</th><th scope="col">Llamadas</th></tr></thead>
          <tbody>{mcp.daily.map((d) => <tr key={d.date}><th scope="row">{d.date}</th><td>{d.calls}</td></tr>)}</tbody>
        </table>
      ) : null}

      {canEdit ? (
        <form method="post" action="/actions/claude-usage/limit" className="stack" aria-label="Límite de llamadas MCP">
          <label>Límite mensual de llamadas MCP<input name="monthlyLimit" type="number" inputMode="numeric" min={0} max={100000000} step={1} required defaultValue={mcp.monthlyLimit} aria-describedby="limit-hint" /></label>
          <p id="limit-hint" className="hint">0 significa sin límite.</p>
          <button type="submit">Guardar límite</button>
        </form>
      ) : null}

      <h2>IA por API</h2>
      <p id="api-bar-label">Presupuesto mensual de IA usado</p>
      <progress className="usage-bar" aria-labelledby="api-bar-label" aria-valuetext={aiText} value={barValue(aiPercent)} max={100} />
      <p>{aiText}</p>
      <p className="hint">Ejecuciones este mes: {ai.runs}.</p>
    </>
  );
}

import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const strategy = text(ctx.form, "strategy", 12) === "round_robin" ? "round_robin" : "manual";
  const rawSla = text(ctx.form, "firstResponseSlaMinutes", 6);
  if (rawSla && !/^\d{1,5}$/.test(rawSla)) return redirectWith("/pipeline/routing", "error", "input");
  const result = await api("/routing/settings", { method: "PUT", token: ctx.token, body: { strategy, firstResponseSlaMinutes: rawSla ? Number(rawSla) : null } });
  return result.ok ? redirectWith("/pipeline/routing", "ok", "saved") : redirectWith("/pipeline/routing", "error", failureCode(result));
}

import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const raw = text(ctx.form, "minScore", 8);
  if (!/^-?\d{1,4}$/.test(raw)) return redirectWith("/leads", "error", "input");
  const result = await api("/leads/settings", { method: "PUT", token: ctx.token, body: { minScore: Number(raw) } });
  return result.ok ? redirectWith("/leads", "ok", "threshold") : redirectWith("/leads", "error", failureCode(result));
}

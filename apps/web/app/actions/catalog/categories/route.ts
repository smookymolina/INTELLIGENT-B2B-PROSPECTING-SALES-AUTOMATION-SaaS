import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const result = await api("/catalog/categories", { method: "POST", token: ctx.token, body: { name: text(ctx.form, "name", 100) } });
  return result.ok ? redirectWith("/catalog/categories", "ok", "category") : redirectWith("/catalog/categories", "error", failureCode(result));
}

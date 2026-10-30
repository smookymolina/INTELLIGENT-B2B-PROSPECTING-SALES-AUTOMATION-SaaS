import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const result = await api("/quotes/settings", { method: "PUT", token: ctx.token, body: { maxDiscountPercent: text(ctx.form, "maxDiscountPercent", 8) } });
  return result.ok ? redirectWith("/sales", "ok", "saved") : redirectWith("/sales", "error", failureCode(result));
}

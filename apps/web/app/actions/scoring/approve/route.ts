import { actionContext, failureCode, isResponse, redirectWith } from "../../../../lib/actions";
import { api } from "../../../../lib/api";

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const result = await api("/scoring/model/approve", { method: "POST", token: ctx.token });
  return result.ok ? redirectWith("/scoring", "ok", "modelapproved") : redirectWith("/scoring", "error", failureCode(result));
}

import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const f = ctx.form;
  const result = await api("/suppressions", { method: "POST", token: ctx.token, body: { kind: text(f, "kind", 10), value: text(f, "value", 300), reason: text(f, "reason", 200) } });
  return result.ok ? redirectWith("/prospects/suppressions", "ok", "suppression") : redirectWith("/prospects/suppressions", "error", failureCode(result));
}

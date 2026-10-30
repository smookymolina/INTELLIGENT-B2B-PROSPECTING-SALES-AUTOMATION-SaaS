import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { parseRules } from "../../../../lib/rules";

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const rules = parseRules(text(ctx.form, "rules", 20_000));
  if (!rules) return redirectWith("/scoring", "error", "input");
  const result = await api("/scoring/model/draft", { method: "PUT", token: ctx.token, body: { rules } });
  return result.ok ? redirectWith("/scoring", "ok", "draftsaved") : redirectWith("/scoring", "error", failureCode(result));
}

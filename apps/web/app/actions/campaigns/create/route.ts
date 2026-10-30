import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { see } from "../../../../lib/session-response";

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const days = Number(text(ctx.form, "minDaysBetween", 3) || "7");
  if (!Number.isInteger(days)) return redirectWith("/campaigns", "error", "input");
  const result = await api<{ id: string }>("/campaigns", { method: "POST", token: ctx.token, body: { name: text(ctx.form, "name", 120), subject: text(ctx.form, "subject", 200), body: text(ctx.form, "body", 5000), minDaysBetween: days } });
  return result.ok ? see(`/campaigns/${result.data.id}?ok=campaigncreated`) : redirectWith("/campaigns", "error", failureCode(result));
}

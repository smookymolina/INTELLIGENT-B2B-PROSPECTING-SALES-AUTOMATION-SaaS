import type { OpportunityDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, orNull, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { see } from "../../../../lib/session-response";

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const f = ctx.form;
  const value = orNull(text(f, "expectedValue", 20));
  const currency = orNull(text(f, "currency", 3).toUpperCase());
  const result = await api<OpportunityDto>("/opportunities", {
    method: "POST",
    token: ctx.token,
    body: { leadId: text(f, "leadId", 36), title: text(f, "title", 200), ...(value || currency ? { expectedValue: value, currency } : {}) },
  });
  return result.ok ? see(`/pipeline/${result.data.id}?ok=opportunity`) : redirectWith("/leads", "error", failureCode(result));
}

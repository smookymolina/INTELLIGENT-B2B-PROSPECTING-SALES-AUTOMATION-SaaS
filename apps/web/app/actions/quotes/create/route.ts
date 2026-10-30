import type { QuoteDetailDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, orNull, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { see } from "../../../../lib/session-response";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const f = ctx.form;
  const opportunityId = text(f, "opportunityId", 36);
  const back = UUID.test(opportunityId) ? `/pipeline/${opportunityId}` : "/pipeline";
  const result = await api<QuoteDetailDto>("/quotes", {
    method: "POST",
    token: ctx.token,
    body: { opportunityId, priceListId: text(f, "priceListId", 36), validUntil: orNull(text(f, "validUntil", 10)), taxRate: orNull(text(f, "taxRate", 10)), notes: orNull(text(f, "notes", 1000)) },
  });
  return result.ok ? see(`/quotes/${result.data.id}?ok=quote`) : redirectWith(back, "error", failureCode(result));
}

import type { PriceListDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, orNull, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { see } from "../../../../lib/session-response";

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const f = ctx.form;
  const result = await api<PriceListDto>("/catalog/price-lists", {
    method: "POST",
    token: ctx.token,
    body: { name: text(f, "name", 120), currency: text(f, "currency", 3).toUpperCase(), validFrom: orNull(text(f, "validFrom", 10)), validUntil: orNull(text(f, "validUntil", 10)) },
  });
  return result.ok ? see(`/pricing/${result.data.id}?ok=created`) : redirectWith("/pricing/new", "error", failureCode(result));
}

import type { BranchDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, orNull, redirectWith, text } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";
import { see } from "../../../../../lib/session-response";

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const f = ctx.form;
  const result = await api<BranchDto>("/branches", {
    method: "POST",
    token: ctx.token,
    body: { name: text(f, "name", 120), address: orNull(text(f, "address", 300)), city: orNull(text(f, "city", 100)), region: orNull(text(f, "region", 100)), country: orNull(text(f, "country", 2).toUpperCase()) },
  });
  return result.ok ? see("/company?ok=branch") : redirectWith("/company", "error", failureCode(result));
}

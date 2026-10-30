import type { ProfileDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, orNull, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { see } from "../../../../lib/session-response";

/** PUT replaces the profile: empty fields are sent as null (cleared); nothing is prefilled or inferred. */
export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const f = ctx.form;
  const result = await api<ProfileDto>("/organization/profile", {
    method: "PUT",
    token: ctx.token,
    body: {
      legalName: orNull(text(f, "legalName", 200)), tradeName: orNull(text(f, "tradeName", 200)), industry: orNull(text(f, "industry", 100)),
      website: orNull(text(f, "website", 300)), description: orNull(text(f, "description", 2000)), country: orNull(text(f, "country", 2).toUpperCase()),
      timezone: orNull(text(f, "timezone", 64)), defaultCurrency: orNull(text(f, "defaultCurrency", 3).toUpperCase()),
    },
  });
  return result.ok ? see("/company?ok=saved") : redirectWith("/company", "error", failureCode(result));
}

import type { SessionDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { see } from "../../../../lib/session-response";

/** Creates a new business (organization) for the signed-in user; the API returns a session already scoped to it and the cookie is replaced. */
export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const organizationName = text(ctx.form, "organizationName", 120);
  if (!organizationName) return redirectWith("/company/new", "error", "input");
  const result = await api<SessionDto>("/auth/organizations", { method: "POST", token: ctx.token, body: { organizationName } });
  if (result.ok) return see("/company/email?ok=bizcreated", result.data);
  return redirectWith("/company/new", "error", result.status === 409 ? "nameexists" : failureCode(result));
}

import type { SessionDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { see } from "../../../../lib/session-response";

/** The API revokes the current session and issues one for the target organization; the cookie is replaced. */
export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const slug = text(ctx.form, "organizationSlug", 64);
  if (!slug) return redirectWith("/", "error", "input");
  const result = await api<SessionDto>("/auth/switch-organization", { method: "POST", token: ctx.token, body: { organizationSlug: slug } });
  return result.ok ? see("/?ok=switched", result.data) : redirectWith("/", "error", failureCode(result));
}

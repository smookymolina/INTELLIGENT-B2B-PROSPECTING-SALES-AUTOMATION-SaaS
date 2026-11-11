import type { EmailSettingsDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";
import { see } from "../../../../../lib/session-response";

/** Removes the SMTP account after a typed confirmation. */
export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  if (text(ctx.form, "confirm", 10) !== "QUITAR") return redirectWith("/company/email", "error", "input");
  const result = await api<EmailSettingsDto>("/organization/email-settings", { method: "DELETE", token: ctx.token });
  return result.ok ? see("/company/email?ok=emailremoved") : redirectWith("/company/email", "error", failureCode(result));
}

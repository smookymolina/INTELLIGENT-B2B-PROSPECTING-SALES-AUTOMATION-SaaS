import type { EmailSettingsDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";
import { see } from "../../../../../lib/session-response";

const BACK = "/notifications-settings";

/** Removes the notifications SMTP account after a typed confirmation. */
export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  if (text(ctx.form, "confirm", 10) !== "QUITAR") return redirectWith(BACK, "error", "input");
  const result = await api<EmailSettingsDto>("/organization/email-settings?purpose=notifications", { method: "DELETE", token: ctx.token });
  return result.ok ? see(`${BACK}?ok=emailremoved`) : redirectWith(BACK, "error", failureCode(result));
}

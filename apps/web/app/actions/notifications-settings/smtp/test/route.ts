import type { EmailSettingsTestDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, redirectWith } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";
import { see } from "../../../../../lib/session-response";

const BACK = "/notifications-settings";

/** Checks the notifications SMTP connection (no message is sent). */
export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const result = await api<EmailSettingsTestDto>("/organization/email-settings/test?purpose=notifications", { method: "POST", token: ctx.token, body: {} });
  if (!result.ok) return redirectWith(BACK, "error", failureCode(result));
  if (!result.data.ok) return redirectWith(BACK, "error", `email_${result.data.failure ?? "unknown"}`);
  return see(`${BACK}?ok=emailverified`);
}

import type { EmailSettingsTestDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";
import { see } from "../../../../../lib/session-response";

/** Checks the SMTP connection; with an address it also sends one test message. The failure shown is a fixed category, never provider text. */
export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const sendTo = text(ctx.form, "sendTo", 254);
  const result = await api<EmailSettingsTestDto>("/organization/email-settings/test", { method: "POST", token: ctx.token, body: sendTo ? { sendTo } : {} });
  if (!result.ok) return redirectWith("/company/email", "error", failureCode(result));
  if (!result.data.ok) return redirectWith("/company/email", "error", `email_${result.data.failure ?? "unknown"}`);
  return see(`/company/email?ok=${result.data.sent ? "emailtestsent" : "emailverified"}`);
}

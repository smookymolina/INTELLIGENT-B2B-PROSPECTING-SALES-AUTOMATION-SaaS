import type { EmailSettingsDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, orNull, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { see } from "../../../../lib/session-response";

const BACK = "/notifications-settings";

/** Saves the SMTP account used for the app's own notifications (purpose is fixed server-side). An empty password keeps the stored one. */
export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const f = ctx.form;
  const raw = f.get("password");
  const password = typeof raw === "string" && raw.length > 0 && raw.length <= 256 ? raw : undefined;
  const port = Number(text(f, "port", 5));
  const result = await api<EmailSettingsDto>("/organization/email-settings?purpose=notifications", {
    method: "PUT",
    token: ctx.token,
    body: {
      host: text(f, "host", 253).toLowerCase(), port: Number.isInteger(port) ? port : 0, secure: port === 465, username: text(f, "username", 254),
      ...(password === undefined ? {} : { password }),
      fromName: orNull(text(f, "fromName", 120)), fromEmail: text(f, "fromEmail", 254), replyTo: null,
    },
  });
  return result.ok ? see(`${BACK}?ok=emailsaved`) : redirectWith(BACK, "error", result.status === 400 ? "emailinput" : failureCode(result));
}

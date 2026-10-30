import type { ChangedPasswordDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, redirectWith } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { see } from "../../../../lib/session-response";

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === "string" ? v.slice(0, 128) : "";
};

/** Passwords are never echoed, logged or placed in a URL. A wrong current password is a 403 from the API: shown as "wrongpassword". */
export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const next = field(ctx.form, "newPassword");
  if (next !== field(ctx.form, "confirmPassword")) return redirectWith("/account", "error", "mismatch");
  const result = await api<ChangedPasswordDto>("/auth/change-password", { method: "POST", token: ctx.token, body: { currentPassword: field(ctx.form, "currentPassword"), newPassword: next } });
  if (result.ok) return see("/account?ok=passwordchanged");
  return redirectWith("/account", "error", result.status === 403 ? "wrongpassword" : failureCode(result));
}

import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";

/** The form takes whole currency-neutral units (up to 6 decimals); the API stores micro-units. */
export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const raw = text(ctx.form, "limit", 20);
  if (!/^\d{1,6}(\.\d{1,6})?$/.test(raw)) return redirectWith("/ai", "error", "input");
  const [whole = "0", frac = ""] = raw.split(".");
  const micros = Number(whole) * 1_000_000 + Number(frac.padEnd(6, "0"));
  const result = await api("/ai/budget", { method: "PUT", token: ctx.token, body: { monthlyLimitMicros: micros } });
  return result.ok ? redirectWith("/ai", "ok", "aibudget") : redirectWith("/ai", "error", failureCode(result));
}

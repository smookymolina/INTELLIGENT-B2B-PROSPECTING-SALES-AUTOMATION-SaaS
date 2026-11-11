import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { parseCount } from "../../../../lib/notif";
import { see } from "../../../../lib/session-response";

const BACK = "/prospects/cohorts";

/** Sets the monthly lead quota (0 = no quota). */
export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const monthlyLeadQuota = parseCount(text(ctx.form, "monthlyLeadQuota", 10), 1_000_000);
  if (monthlyLeadQuota === null) return redirectWith(BACK, "error", "number");
  const result = await api<unknown>("/prospects/lead-quota", { method: "PUT", token: ctx.token, body: { monthlyLeadQuota } });
  return result.ok ? see(`${BACK}?ok=leadquota`) : redirectWith(BACK, "error", failureCode(result));
}

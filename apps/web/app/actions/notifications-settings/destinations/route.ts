import type { NotificationEmailDestinationsDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, redirectWith } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { parseAddresses } from "../../../../lib/notif";
import { see } from "../../../../lib/session-response";

const BACK = "/notifications-settings";
const TYPES = new Set(["task_overdue", "task_due_soon", "lead_assigned", "opportunity_assigned", "sla_breached", "draft_pending_review"]);

/** Replaces the e-mail destinations (<= 5) and the event types that are e-mailed. */
export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const addresses = parseAddresses(ctx.form.getAll("address").filter((v): v is string => typeof v === "string").map((v) => v.slice(0, 254)));
  if (!addresses) return redirectWith(BACK, "error", "addresses");
  const enabledTypes = ctx.form.getAll("enabledType").filter((v): v is string => typeof v === "string" && TYPES.has(v));
  const result = await api<NotificationEmailDestinationsDto>("/notifications/email-destinations", { method: "PUT", token: ctx.token, body: { addresses, enabledTypes } });
  return result.ok ? see(`${BACK}?ok=notifdestinations`) : redirectWith(BACK, "error", failureCode(result));
}

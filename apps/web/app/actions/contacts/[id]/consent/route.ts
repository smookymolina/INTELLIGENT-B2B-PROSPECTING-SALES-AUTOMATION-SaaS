import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** The person records the event and its evidence; the date is a UTC wall-clock value converted to an explicit instant. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const prospectId = text(ctx.form, "prospectId", 36);
  const back = UUID.test(prospectId) ? `/prospects/${prospectId}` : "/prospects";
  const when = text(ctx.form, "occurredAt", 16);
  const event = text(ctx.form, "event", 10);
  if (!UUID.test(id) || !LOCAL.test(when) || (event !== "granted" && event !== "withdrawn")) return redirectWith(back, "error", "input");
  const result = await api(`/contacts/${id}/consent`, { method: "POST", token: ctx.token, body: { event, evidence: text(ctx.form, "evidence", 500), occurredAt: `${when}:00.000Z` } });
  return result.ok ? redirectWith(back, "ok", "consentrecorded") : redirectWith(back, "error", failureCode(result));
}

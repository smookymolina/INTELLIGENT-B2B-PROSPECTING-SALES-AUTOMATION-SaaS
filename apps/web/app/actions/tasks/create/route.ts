import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** The form sends a UTC wall-clock value (datetime-local); the API receives an explicit ISO instant. */
export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const opportunityId = text(ctx.form, "opportunityId", 36);
  if (!UUID.test(opportunityId)) return redirectWith("/tasks", "error", "notfound");
  const back = `/pipeline/${opportunityId}`;
  const due = text(ctx.form, "dueAt", 16);
  if (!LOCAL.test(due)) return redirectWith(back, "error", "input");
  const result = await api(`/opportunities/${opportunityId}/tasks`, { method: "POST", token: ctx.token, body: { title: text(ctx.form, "title", 200), dueAt: `${due}:00.000Z` } });
  return result.ok ? redirectWith(back, "ok", "task") : redirectWith(back, "error", failureCode(result));
}

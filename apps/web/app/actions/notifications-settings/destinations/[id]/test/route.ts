import { actionContext, failureCode, isResponse, redirectWith } from "../../../../../../lib/actions";
import { api } from "../../../../../../lib/api";
import { see } from "../../../../../../lib/session-response";

const BACK = "/notifications-settings";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Queues a test e-mail to one destination (the worker sends it). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!UUID.test(id)) return new Response("Not found", { status: 404 });
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const result = await api<{ queued: boolean }>(`/notifications/email-destinations/${id}/test`, { method: "POST", token: ctx.token, body: {} });
  return result.ok ? see(`${BACK}?ok=notiftestqueued`) : redirectWith(BACK, "error", failureCode(result));
}

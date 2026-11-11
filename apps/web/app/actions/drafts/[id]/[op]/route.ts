import { actionContext, isResponse, redirectWith, text } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";
import { draftFailureCode } from "../../../../../lib/outreach";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPS = new Set(["approve", "reject", "send"]);

/** Human decision on a draft. Approving never sends anything; "send" only queues the delivery for the worker. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; op: string }> }): Promise<Response> {
  const { id, op } = await params;
  if (!UUID.test(id) || !OPS.has(op)) return new Response("Not found", { status: 404 });
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const back = `/drafts/${id}`;
  const note = text(ctx.form, "note", 500);
  if (op === "reject" && !note) return redirectWith(back, "error", "input");
  const result = await api(`/message-drafts/${id}/${op}`, { method: "POST", token: ctx.token, ...(op === "reject" ? { body: { note } } : {}) });
  return result.ok ? redirectWith(back, "ok", op === "approve" ? "draftapproved" : op === "send" ? "draftqueued" : "draftrejected") : redirectWith(back, "error", draftFailureCode(result));
}

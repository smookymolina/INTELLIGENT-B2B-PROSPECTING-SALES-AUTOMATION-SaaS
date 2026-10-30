import { actionContext, failureCode, isResponse, orNull, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!UUID.test(id)) return new Response("Not found", { status: 404 });
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const decision = text(ctx.form, "decision", 10) === "accept" ? "accept" : "reject";
  const result = await api(`/leads/${id}/decision`, { method: "POST", token: ctx.token, body: { decision, note: orNull(text(ctx.form, "note", 300)) } });
  return result.ok ? redirectWith("/leads", "ok", decision === "accept" ? "leadaccepted" : "leadrejected") : redirectWith("/leads", "error", failureCode(result));
}

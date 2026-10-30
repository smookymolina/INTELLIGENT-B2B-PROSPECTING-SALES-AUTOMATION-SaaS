import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPS = new Set(["complete", "cancel"]);
const BACK = /^\/pipeline\/[0-9a-f-]{36}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string; op: string }> }): Promise<Response> {
  const { id, op } = await params;
  if (!UUID.test(id) || !OPS.has(op)) return new Response("Not found", { status: 404 });
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const requested = text(ctx.form, "back", 60);
  const back = BACK.test(requested) ? requested : "/tasks"; // only same-site, known destinations (no open redirect)
  const result = await api(`/tasks/${id}/${op}`, { method: "POST", token: ctx.token });
  return result.ok ? redirectWith(back, "ok", op === "complete" ? "taskdone" : "taskcancelled") : redirectWith(back, "error", failureCode(result));
}

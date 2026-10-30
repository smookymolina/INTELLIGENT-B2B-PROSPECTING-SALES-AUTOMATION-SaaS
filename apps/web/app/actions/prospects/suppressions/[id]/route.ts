import { actionContext, failureCode, isResponse, redirectWith } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST (not DELETE) because HTML forms only submit GET/POST; the API call itself is a DELETE. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!UUID.test(id)) return new Response("Not found", { status: 404 });
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const result = await api(`/suppressions/${id}`, { method: "DELETE", token: ctx.token });
  return result.ok ? redirectWith("/prospects/suppressions", "ok", "removed") : redirectWith("/prospects/suppressions", "error", failureCode(result));
}

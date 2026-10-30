import { actionContext, failureCode, isResponse, redirectWith } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST (HTML forms cannot DELETE): removes a member from the routing pool. */
export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }): Promise<Response> {
  const { userId } = await params;
  if (!UUID.test(userId)) return new Response("Not found", { status: 404 });
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const result = await api(`/routing/pool/${userId}`, { method: "DELETE", token: ctx.token });
  return result.ok ? redirectWith("/pipeline/routing", "ok", "removed") : redirectWith("/pipeline/routing", "error", failureCode(result));
}

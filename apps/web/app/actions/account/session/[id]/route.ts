import { actionContext, failureCode, isResponse, redirectWith } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";
import { see } from "../../../../../lib/session-response";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const { id } = await params;
  if (!UUID.test(id)) return redirectWith("/account", "error", "notfound");
  const result = await api(`/auth/sessions/${id}`, { method: "DELETE", token: ctx.token });
  return result.ok ? see("/account?ok=sessionrevoked") : redirectWith("/account", "error", failureCode(result));
}

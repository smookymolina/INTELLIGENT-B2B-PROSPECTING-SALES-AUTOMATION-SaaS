import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const userId = text(ctx.form, "userId", 36);
  const maxOpen = text(ctx.form, "maxOpen", 4);
  if (!UUID.test(userId) || !/^\d{1,3}$/.test(maxOpen)) return redirectWith("/pipeline/routing", "error", "input");
  const active = ctx.form.get("active") === "on";
  const result = await api(`/routing/pool/${userId}`, { method: "PUT", token: ctx.token, body: { active, maxOpen: Number(maxOpen) } });
  return result.ok ? redirectWith("/pipeline/routing", "ok", "saved") : redirectWith("/pipeline/routing", "error", failureCode(result));
}

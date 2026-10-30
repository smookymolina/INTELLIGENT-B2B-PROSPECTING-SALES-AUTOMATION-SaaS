import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const prospectId = text(ctx.form, "prospectId", 36);
  if (!UUID.test(prospectId)) return redirectWith("/prospects", "error", "notfound");
  const back = `/prospects/${prospectId}`;
  const name = text(ctx.form, "displayName", 120);
  const result = await api(`/prospects/${prospectId}/contacts`, { method: "POST", token: ctx.token, body: { address: text(ctx.form, "address", 254), source: text(ctx.form, "source", 300), ...(name ? { displayName: name } : {}) } });
  return result.ok ? redirectWith(back, "ok", "contactadded") : redirectWith(back, "error", failureCode(result));
}

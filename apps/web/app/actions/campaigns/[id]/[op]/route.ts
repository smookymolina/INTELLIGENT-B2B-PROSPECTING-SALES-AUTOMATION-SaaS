import { actionContext, failureCode, isResponse, redirectWith } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Closed set of operations on one campaign; each maps to exactly one API call and one confirmation message. */
const OPS: Record<string, { ok: string; body?: unknown }> = {
  approve: { ok: "campaignapproved" },
  launch: { ok: "campaignlaunched" },
  dispatch: { ok: "campaigndispatched", body: { limit: 50 } },
  pause: { ok: "campaignpaused" },
  resume: { ok: "campaignresumed" },
  cancel: { ok: "campaigncancelled" },
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string; op: string }> }): Promise<Response> {
  const { id, op } = await params;
  const spec = OPS[op];
  if (!UUID.test(id) || !spec) return new Response("Not found", { status: 404 });
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const back = `/campaigns/${id}`;
  const result = await api(`/campaigns/${id}/${op}`, { method: "POST", token: ctx.token, ...(spec.body ? { body: spec.body } : {}) });
  if (result.ok) return redirectWith(back, "ok", spec.ok);
  return redirectWith(back, "error", result.status === 503 ? "noprovider" : failureCode(result));
}

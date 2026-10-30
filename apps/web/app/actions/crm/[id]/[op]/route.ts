import { actionContext, failureCode, isResponse, orNull, redirectWith, text } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPS = new Set(["stage", "note", "assign", "auto-assign"]);

/** Closed set of operations on one opportunity. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; op: string }> }): Promise<Response> {
  const { id, op } = await params;
  if (!UUID.test(id) || !OPS.has(op)) return new Response("Not found", { status: 404 });
  const back = `/pipeline/${id}`;
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const f = ctx.form;
  const token = ctx.token;
  const base = `/opportunities/${id}`;

  let result;
  let ok = "stage";
  if (op === "stage") {
    const stage = text(f, "stage", 20);
    result = await api(`${base}/stage`, { method: "POST", token, body: { stage, note: orNull(text(f, "note", 300)), ...(stage === "lost" ? { lossReason: text(f, "lossReason", 200) || null } : {}) } });
  } else if (op === "note") {
    result = await api(`${base}/notes`, { method: "POST", token, body: { kind: text(f, "kind", 10), body: text(f, "body", 2000) } });
    ok = "noted";
  } else if (op === "assign") {
    const userId = text(f, "userId", 36);
    if (userId && !UUID.test(userId)) return redirectWith(back, "error", "input");
    result = await api(`${base}/assign`, { method: "POST", token, body: { userId: userId || null } });
    ok = "assigned";
  } else {
    result = await api(`${base}/auto-assign`, { method: "POST", token });
    ok = "assigned";
  }
  return result.ok ? redirectWith(back, "ok", ok) : redirectWith(back, "error", failureCode(result));
}

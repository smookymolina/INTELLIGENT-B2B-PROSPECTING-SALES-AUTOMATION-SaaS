import { actionContext, failureCode, isResponse, orNull, redirectWith, text } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPS = new Set(["update", "line", "unline", "approve-discount", "send", "decision"]);

/** Closed set of operations on one quote. Prices are never accepted from the form: the API builds lines from approved evidence. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; op: string }> }): Promise<Response> {
  const { id, op } = await params;
  if (!UUID.test(id) || !OPS.has(op)) return new Response("Not found", { status: 404 });
  const back = `/quotes/${id}`;
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const f = ctx.form;
  const token = ctx.token;
  const base = `/quotes/${id}`;

  let result;
  let ok = op;
  if (op === "update") {
    result = await api(base, { method: "PATCH", token, body: { validUntil: orNull(text(f, "validUntil", 10)), taxRate: orNull(text(f, "taxRate", 10)), notes: orNull(text(f, "notes", 1000)) } });
    ok = "updated";
  } else if (op === "line") {
    const discount = text(f, "discountPercent", 8);
    result = await api(`${base}/lines`, { method: "POST", token, body: { sku: text(f, "sku", 64), quantity: text(f, "quantity", 20), ...(discount ? { discountPercent: discount } : {}) } });
    ok = "lineadded";
  } else if (op === "unline") {
    const lineId = text(f, "lineId", 36);
    if (!UUID.test(lineId)) return redirectWith(back, "error", "input");
    result = await api(`${base}/lines/${lineId}`, { method: "DELETE", token });
    ok = "lineremoved";
  } else if (op === "decision") {
    const decision = text(f, "decision", 10);
    result = await api(`${base}/decision`, { method: "POST", token, body: { decision, note: orNull(text(f, "note", 300)) } });
    ok = decision === "accept" ? "accepted" : decision === "reject" ? "rejected" : "cancelled";
  } else {
    result = await api(`${base}/${op}`, { method: "POST", token });
    ok = op === "send" ? "sent" : "discountapproved";
  }
  return result.ok ? redirectWith(back, "ok", ok) : redirectWith(back, "error", failureCode(result));
}

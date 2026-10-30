import { actionContext, failureCode, isResponse, orNull, redirectWith, text } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPS = new Set(["update", "status", "attribute", "decision", "score", "reply"]);

/** Closed set of operations on one prospect; anything else is a 404 so URLs cannot reach other API routes. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; op: string }> }): Promise<Response> {
  const { id, op } = await params;
  if (!UUID.test(id) || !OPS.has(op)) return new Response("Not found", { status: 404 });
  const back = `/prospects/${id}`;
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const f = ctx.form;
  const token = ctx.token;

  let result;
  let ok = "updated";
  if (op === "status") {
    result = await api(`/prospects/${id}/status`, { method: "POST", token, body: { status: text(f, "status", 20), reason: orNull(text(f, "reason", 200)) } });
    ok = "status";
  } else if (op === "attribute") {
    result = await api(`/prospects/${id}/attributes`, { method: "POST", token, body: { key: text(f, "key", 40), value: text(f, "value", 200), confidence: text(f, "confidence", 10) } });
    ok = "attribute";
  } else if (op === "decision") {
    const attributeId = text(f, "attributeId", 36);
    if (!UUID.test(attributeId)) return redirectWith(back, "error", "input");
    result = await api(`/prospects/${id}/attributes/${attributeId}/decision`, { method: "POST", token, body: { decision: text(f, "decision", 10) } });
    ok = "decided";
  } else if (op === "score") {
    result = await api(`/prospects/${id}/score`, { method: "POST", token });
    ok = "scored";
  } else if (op === "reply") {
    result = await api(`/prospects/${id}/replies`, { method: "POST", token, body: { text: text(f, "text", 4000) } });
    ok = "replied";
  } else {
    result = await api(`/prospects/${id}`, {
      method: "PATCH",
      token,
      body: {
        name: text(f, "name", 200), domain: orNull(text(f, "domain", 300)), country: orNull(text(f, "country", 2).toUpperCase()),
        region: orNull(text(f, "region", 100)), city: orNull(text(f, "city", 100)), industry: orNull(text(f, "industry", 100)), notes: orNull(text(f, "notes", 2000)),
      },
    });
  }
  return result.ok ? redirectWith(back, "ok", ok) : redirectWith(back, "error", failureCode(result));
}

import type { PriceListDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, orNull, redirectWith, text } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";
import { see } from "../../../../../lib/session-response";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPS = new Set(["update", "clone", "approve", "archive", "price", "unprice"]);

/** Closed set of operations; the price amount is always forwarded as a string and validated by the API. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; op: string }> }): Promise<Response> {
  const { id, op } = await params;
  if (!UUID.test(id) || !OPS.has(op)) return new Response("Not found", { status: 404 });
  const back = `/pricing/${id}`;
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const f = ctx.form;
  const base = `/catalog/price-lists/${id}`;
  const token = ctx.token;

  if (op === "clone") {
    const result = await api<PriceListDto>(`${base}/clone`, { method: "POST", token, body: { name: text(f, "name", 120) } });
    return result.ok ? see(`/pricing/${result.data.id}?ok=cloned`) : redirectWith(back, "error", failureCode(result));
  }
  const itemId = text(f, "itemId", 36);
  const result =
    op === "update" ? await api(base, { method: "PATCH", token, body: { name: text(f, "name", 120), validFrom: orNull(text(f, "validFrom", 10)), validUntil: orNull(text(f, "validUntil", 10)) } })
    : op === "approve" || op === "archive" ? await api(`${base}/${op}`, { method: "POST", token })
    : !UUID.test(itemId) ? null
    : op === "price" ? await api(`${base}/entries/${itemId}`, { method: "PUT", token, body: { unitPrice: text(f, "unitPrice", 40) } })
    : await api(`${base}/entries/${itemId}`, { method: "DELETE", token });
  if (!result) return redirectWith(back, "error", "input");
  return result.ok ? redirectWith(back, "ok", op === "update" ? "updated" : op) : redirectWith(back, "error", failureCode(result));
}

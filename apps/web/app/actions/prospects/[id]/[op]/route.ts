import { actionContext, failureCode, isResponse, orNull, redirectWith, text } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string; op: string }> }): Promise<Response> {
  const { id, op } = await params;
  if (!UUID.test(id) || (op !== "update" && op !== "status")) return new Response("Not found", { status: 404 });
  const back = `/prospects/${id}`;
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const f = ctx.form;
  const result =
    op === "status"
      ? await api(`/prospects/${id}/status`, { method: "POST", token: ctx.token, body: { status: text(f, "status", 20), reason: orNull(text(f, "reason", 200)) } })
      : await api(`/prospects/${id}`, {
          method: "PATCH",
          token: ctx.token,
          body: {
            name: text(f, "name", 200), domain: orNull(text(f, "domain", 300)), country: orNull(text(f, "country", 2).toUpperCase()),
            region: orNull(text(f, "region", 100)), city: orNull(text(f, "city", 100)), industry: orNull(text(f, "industry", 100)), notes: orNull(text(f, "notes", 2000)),
          },
        });
  return result.ok ? redirectWith(back, "ok", op === "status" ? "status" : "updated") : redirectWith(back, "error", failureCode(result));
}

import { actionContext, failureCode, isResponse, orNull, parseFeatures, redirectWith, text } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** op -> API call. Anything not listed is a 404, so URLs cannot be used to reach other API routes. */
const SIMPLE = { draft: "versions", approve: "approve", archive: "archive", restore: "restore" } as const;

export async function POST(request: Request, { params }: { params: Promise<{ id: string; op: string }> }): Promise<Response> {
  const { id, op } = await params;
  if (!UUID.test(id)) return new Response("Not found", { status: 404 });
  const back = `/catalog/${id}`;
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;

  if (op === "update") {
    const features = parseFeatures(text(ctx.form, "features", 6000));
    if (!features) return redirectWith(back, "error", "input");
    const result = await api(`/catalog/items/${id}`, {
      method: "PATCH",
      token: ctx.token,
      body: {
        name: text(ctx.form, "name", 200), description: orNull(text(ctx.form, "description")), unit: orNull(text(ctx.form, "unit", 30)),
        categoryId: orNull(text(ctx.form, "categoryId", 36)), features,
      },
    });
    return result.ok ? redirectWith(back, "ok", "updated") : redirectWith(back, "error", failureCode(result));
  }
  if (!(op in SIMPLE)) return new Response("Not found", { status: 404 });
  const result = await api(`/catalog/items/${id}/${SIMPLE[op as keyof typeof SIMPLE]}`, { method: "POST", token: ctx.token });
  return result.ok ? redirectWith(back, "ok", op) : redirectWith(back, "error", failureCode(result));
}

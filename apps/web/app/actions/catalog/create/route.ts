import type { ItemDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, orNull, parseFeatures, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { see } from "../../../../lib/session-response";

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const features = parseFeatures(text(ctx.form, "features", 6000));
  if (!features) return redirectWith("/catalog/new", "error", "input");
  const result = await api<ItemDto>("/catalog/items", {
    method: "POST",
    token: ctx.token,
    body: {
      kind: text(ctx.form, "kind", 20), sku: text(ctx.form, "sku", 64), name: text(ctx.form, "name", 200),
      description: orNull(text(ctx.form, "description")), unit: orNull(text(ctx.form, "unit", 30)), categoryId: orNull(text(ctx.form, "categoryId", 36)), features,
    },
  });
  return result.ok ? see(`/catalog/${result.data.id}?ok=created`) : redirectWith("/catalog/new", "error", failureCode(result));
}

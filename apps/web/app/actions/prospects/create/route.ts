import type { ProspectDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, orNull, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { see } from "../../../../lib/session-response";

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const f = ctx.form;
  const result = await api<ProspectDto>("/prospects", {
    method: "POST",
    token: ctx.token,
    body: {
      name: text(f, "name", 200), domain: orNull(text(f, "domain", 300)), country: orNull(text(f, "country", 2).toUpperCase()),
      region: orNull(text(f, "region", 100)), city: orNull(text(f, "city", 100)), industry: orNull(text(f, "industry", 100)), notes: orNull(text(f, "notes", 2000)),
    },
  });
  if (result.ok) return see(`/prospects/${result.data.id}?ok=created`);
  const existing = (result.problem?.details as { existingId?: string } | null)?.existingId;
  if (result.status === 409 && existing && /^[0-9a-f-]{36}$/i.test(existing)) return see(`/prospects/${existing}?error=conflict`); // take the user to the record that already exists
  return redirectWith("/prospects/new", "error", failureCode(result));
}

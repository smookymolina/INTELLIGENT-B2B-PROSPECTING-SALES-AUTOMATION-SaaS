import type { BranchDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, orNull, redirectWith, text } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";
import { see } from "../../../../../lib/session-response";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Edit fields or change status ("op" = save | disable | enable). Branches are never deleted. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const { id } = await params;
  if (!UUID.test(id)) return redirectWith("/company", "error", "notfound");
  const f = ctx.form;
  const op = text(f, "op", 10);
  let body: Record<string, unknown>;
  if (op === "disable") body = { status: "disabled" };
  else if (op === "enable") body = { status: "active" };
  else if (op === "save") body = { name: text(f, "name", 120), address: orNull(text(f, "address", 300)), city: orNull(text(f, "city", 100)), region: orNull(text(f, "region", 100)), country: orNull(text(f, "country", 2).toUpperCase()) };
  else return redirectWith("/company", "error", "input");
  const result = await api<BranchDto>(`/branches/${id}`, { method: "PATCH", token: ctx.token, body });
  return result.ok ? see("/company?ok=branchupdated") : redirectWith("/company", "error", failureCode(result));
}

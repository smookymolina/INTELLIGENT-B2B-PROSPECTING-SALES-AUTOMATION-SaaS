import { MEMBERSHIP_ROLES } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../../lib/actions";
import { api } from "../../../../../lib/api";
import { see } from "../../../../../lib/session-response";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Closed set of operations: "role" (PATCH) and "remove" (DELETE). The tenant always comes from the session. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const { id } = await params;
  if (!UUID.test(id)) return redirectWith("/team", "error", "notfound");
  const op = text(ctx.form, "op", 10);
  if (op === "remove") {
    const result = await api(`/memberships/${id}`, { method: "DELETE", token: ctx.token });
    return result.ok ? see("/team?ok=memberremoved") : redirectWith("/team", "error", failureCode(result));
  }
  const role = text(ctx.form, "role", 30);
  if (op !== "role" || !(MEMBERSHIP_ROLES as readonly string[]).includes(role)) return redirectWith("/team", "error", "input");
  const result = await api(`/memberships/${id}`, { method: "PATCH", token: ctx.token, body: { role } });
  return result.ok ? see("/team?ok=rolechanged") : redirectWith("/team", "error", failureCode(result));
}

import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { parseCount } from "../../../../lib/notif";
import { see } from "../../../../lib/session-response";

const BACK = "/claude-usage";

/** Sets the internal monthly MCP call limit (0 = no limit). */
export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const monthlyLimit = parseCount(text(ctx.form, "monthlyLimit", 12), 100_000_000);
  if (monthlyLimit === null) return redirectWith(BACK, "error", "number");
  const result = await api<unknown>("/ai/mcp-limit", { method: "PUT", token: ctx.token, body: { monthlyLimit } });
  return result.ok ? see(`${BACK}?ok=mcplimit`) : redirectWith(BACK, "error", failureCode(result));
}

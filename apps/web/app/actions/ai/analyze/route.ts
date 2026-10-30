import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";

/** Refs come one per line (or comma separated). The result is recorded in the ledger and shown in the runs table, never acted on. */
export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const refs = text(ctx.form, "refs", 2000).split(/[\s,]+/).filter(Boolean);
  const result = await api("/ai/analyze", { method: "POST", token: ctx.token, body: { capability: "offer_brief", text: text(ctx.form, "text", 4000), evidenceRefs: refs.slice(0, 11) } });
  if (result.ok) return redirectWith("/ai", "ok", "aianalyzed");
  if (result.status === 429) return redirectWith("/ai", "error", "aibudget");
  if (result.status === 409) return redirectWith("/ai", "error", "noevidence");
  return redirectWith("/ai", "error", failureCode(result));
}

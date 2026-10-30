import { actionContext, failureCode, isResponse, redirectWith } from "../../../../lib/actions";
import { api } from "../../../../lib/api";

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const result = await api<{ created: number }>("/leads/evaluate", { method: "POST", token: ctx.token });
  return result.ok ? redirectWith(`/leads?created=${result.data.created}`, "ok", "evaluated") : redirectWith("/leads", "error", failureCode(result));
}

import type { ProspectImportResultDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { see } from "../../../../lib/session-response";

export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const mode = text(ctx.form, "mode", 10) === "apply" ? "apply" : "dry_run";
  const csv = text(ctx.form, "csv", 1_000_000);
  if (!csv) return redirectWith("/prospects/import", "error", "input");
  const result = await api<ProspectImportResultDto>("/prospects/imports", { method: "POST", token: ctx.token, body: { mode, csv } });
  return result.ok ? see(`/prospects/import?job=${result.data.id}`) : redirectWith("/prospects/import", "error", failureCode(result));
}

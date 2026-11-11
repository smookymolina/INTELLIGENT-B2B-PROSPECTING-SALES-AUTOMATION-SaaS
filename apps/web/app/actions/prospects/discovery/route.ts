import { DISCOVERY_LIMITS, type DiscoveryImportDto } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { see } from "../../../../lib/session-response";

const PAGE = "/prospects/discovery";

/** Imports the selected OpenStreetMap results. Only ids travel: the API re-reads the business data from OSM itself. */
export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const osmIds = [...new Set(ctx.form.getAll("osmIds").filter((v): v is string => typeof v === "string" && /^(node|way)\/[1-9]\d{0,18}$/.test(v)))].slice(0, DISCOVERY_LIMITS.maxImport);
  if (osmIds.length === 0) return redirectWith(PAGE, "error", "input");
  const country = text(ctx.form, "country", 2);
  const result = await api<DiscoveryImportDto>("/prospects/discovery/import", {
    method: "POST", token: ctx.token, body: { osmIds, country: /^[A-Z]{2}$/.test(country) ? country : null },
  });
  if (!result.ok) return redirectWith(PAGE, "error", failureCode(result));
  const d = result.data;
  return see(`${PAGE}?created=${d.created}&dup=${d.skippedDuplicate}&sup=${d.skippedSuppressed}&nf=${d.skippedNotFound}`);
}

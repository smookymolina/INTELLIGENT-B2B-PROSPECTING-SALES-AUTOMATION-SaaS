import type { PrivacyRequestDto, RetentionRunDto } from "@prospecting/contracts";
import { RETENTION_CLASSES } from "@prospecting/contracts";
import { actionContext, failureCode, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPS = new Set(["retention", "run", "create", "complete", "reject", "lift"]);
const KINDS = new Set(["access", "restrict", "erase"]);
const BACK = "/privacy";

/** Retention, purge and data-subject requests. The access package is returned once as a no-store download (the API never stores it). */
export async function POST(request: Request, { params }: { params: Promise<{ op: string }> }): Promise<Response> {
  const { op } = await params;
  if (!OPS.has(op)) return new Response("Not found", { status: 404 });
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const { token, form } = ctx;
  const fail = (r: Parameters<typeof failureCode>[0]) => redirectWith(BACK, "error", failureCode(r));

  if (op === "retention") {
    const policies = RETENTION_CLASSES.flatMap((c) => {
      const raw = text(form, `days_${c}`, 6);
      return raw ? [{ dataClass: c, retentionDays: Number(raw) }] : [];
    });
    if (policies.length === 0 || policies.some((p) => !Number.isInteger(p.retentionDays))) return redirectWith(BACK, "error", "input");
    const r = await api("/privacy/retention", { method: "PUT", token, body: { policies } });
    return r.ok ? redirectWith(BACK, "ok", "retentionsaved") : fail(r);
  }
  if (op === "run") {
    const dryRun = form.get("confirm") !== "yes";
    const r = await api<RetentionRunDto>("/privacy/retention/run", { method: "POST", token, body: { dryRun } });
    if (!r.ok) return fail(r);
    if (dryRun) {
      const n = r.data.classes.reduce((s, c) => s + c.eligible, 0);
      return redirectWith(`${BACK}?eligible=${n}`, "ok", "retentiondry");
    }
    return redirectWith(BACK, "ok", "retentionrun");
  }
  if (op === "create") {
    const contactId = text(form, "contactId", 40);
    const kind = text(form, "kind", 10);
    if (!UUID.test(contactId) || !KINDS.has(kind)) return redirectWith(BACK, "error", "input");
    const r = await api<PrivacyRequestDto>("/privacy/requests", { method: "POST", token, body: { contactId, kind } });
    return r.ok ? redirectWith(BACK, "ok", "privacycreated") : fail(r);
  }
  const id = text(form, "id", 40);
  if (!UUID.test(id)) return redirectWith(BACK, "error", "input");
  if (op === "complete") {
    const r = await api<PrivacyRequestDto>(`/privacy/requests/${id}/complete`, { method: "POST", token });
    if (!r.ok) return fail(r);
    if (r.data.kind === "access" && r.data.accessPackage) {
      return new Response(JSON.stringify(r.data.accessPackage, null, 2), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="acceso-${id.slice(0, 8)}.json"`, "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    }
    return redirectWith(BACK, "ok", "privacycompleted");
  }
  const note = text(form, "note", 500);
  if (note.length < 3) return redirectWith(BACK, "error", "input");
  if (op === "reject") {
    const r = await api(`/privacy/requests/${id}/reject`, { method: "POST", token, body: { note } });
    return r.ok ? redirectWith(BACK, "ok", "privacyrejected") : fail(r);
  }
  const contactId = text(form, "contactId", 40);
  if (!UUID.test(contactId)) return redirectWith(BACK, "error", "input");
  const r = await api(`/privacy/contacts/${contactId}/lift-restriction`, { method: "POST", token, body: { note } });
  return r.ok ? redirectWith(BACK, "ok", "privacylifted") : fail(r);
}

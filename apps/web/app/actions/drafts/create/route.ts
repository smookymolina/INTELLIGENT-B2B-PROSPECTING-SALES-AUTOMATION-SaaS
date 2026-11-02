import { actionContext, isResponse, redirectWith, text } from "../../../../lib/actions";
import { api } from "../../../../lib/api";
import { cleanRefs, draftFailureCode } from "../../../../lib/outreach";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Creates a manual draft for review. Nothing is sent: the API only stores it as pending_review. */
export async function POST(request: Request): Promise<Response> {
  const ctx = await actionContext(request);
  if (isResponse(ctx)) return ctx;
  const f = ctx.form;
  const contactId = text(f, "contactId", 36);
  if (!UUID.test(contactId)) return redirectWith("/drafts", "error", "notfound");
  const back = `/drafts/new?contactId=${contactId}`;
  const channel = text(f, "channel", 10);
  if (channel !== "email" && channel !== "whatsapp") return redirectWith(back, "error", "input");
  const body: Record<string, unknown> = { contactId, channel, body: text(f, "body", 5000), evidenceRefs: cleanRefs(f.getAll("evidence")) };
  if (channel === "email") body.subject = text(f, "subject", 200);
  const result = await api<{ id: string }>("/message-drafts", { method: "POST", token: ctx.token, body });
  return result.ok ? redirectWith(`/drafts/${result.data.id}`, "ok", "draftcreated") : redirectWith(back, "error", draftFailureCode(result));
}

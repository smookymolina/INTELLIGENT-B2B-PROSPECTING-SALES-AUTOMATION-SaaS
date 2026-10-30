import { sameOrigin } from "../../../../lib/csrf";
import { api } from "../../../../lib/api";
import { see } from "../../../../lib/session-response";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === "string" ? v.slice(0, 100) : "";
};

/** Public: no session. Same-origin check still applies; the API verifies the signature and answers the same for every request. */
export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request.headers)) return new Response("Forbidden", { status: 403 });
  const form = await request.formData();
  const [org, contact, sig] = [field(form, "o"), field(form, "c"), field(form, "s")];
  if (!UUID.test(org) || !UUID.test(contact) || !/^[0-9a-f]{64}$/.test(sig)) return see("/unsubscribe?error=input");
  const result = await api("/public/unsubscribe", { method: "POST", body: { org, contact, sig } });
  return see(result.ok ? "/unsubscribe?ok=unsubscribed" : "/unsubscribe?error=unavailable");
}

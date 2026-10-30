import { api } from "../../../lib/api";
import { sameOrigin } from "../../../lib/csrf";
import { readSessionToken } from "../../../lib/session";
import { see } from "../../../lib/session-response";

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request.headers)) return new Response("Forbidden", { status: 403 });
  const token = await readSessionToken();
  if (token) await api("/auth/logout", { method: "POST", token }); // revoke server-side; the cookie is cleared regardless
  return see("/login", "clear");
}

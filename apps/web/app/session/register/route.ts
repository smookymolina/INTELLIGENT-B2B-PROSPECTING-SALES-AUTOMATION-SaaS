import type { SessionDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { clientIp, sameOrigin } from "../../../lib/csrf";
import { errorCode, field, see } from "../../../lib/session-response";

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request.headers)) return new Response("Forbidden", { status: 403 });
  const form = await request.formData();
  // The key is generated when the form is rendered, so a double submit or a retry replays the same registration instead of failing.
  const key = field(form, "idempotencyKey", 128);
  const result = await api<SessionDto>("/auth/register", {
    method: "POST",
    body: {
      email: field(form, "email"),
      password: field(form, "password", 128),
      displayName: field(form, "displayName", 100),
      organizationName: field(form, "organizationName", 100),
    },
    headers: { "x-forwarded-for": clientIp(request.headers), ...(/^[A-Za-z0-9_.:-]{8,128}$/.test(key) ? { "idempotency-key": key } : {}) },
  });
  return result.ok ? see("/", result.data) : see(`/register?error=${errorCode(result)}`);
}

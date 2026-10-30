import type { SessionDto } from "@prospecting/contracts";
import { api } from "../../../lib/api";
import { clientIp, sameOrigin } from "../../../lib/csrf";
import { errorCode, field, see } from "../../../lib/session-response";

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request.headers)) return new Response("Forbidden", { status: 403 });
  const form = await request.formData();
  const slug = field(form, "organizationSlug", 64).trim();
  const result = await api<SessionDto>("/auth/login", {
    method: "POST",
    body: { email: field(form, "email"), password: field(form, "password", 128), ...(slug ? { organizationSlug: slug } : {}) },
    headers: { "x-forwarded-for": clientIp(request.headers) },
  });
  return result.ok ? see("/", result.data) : see(`/login?error=${errorCode(result)}`);
}

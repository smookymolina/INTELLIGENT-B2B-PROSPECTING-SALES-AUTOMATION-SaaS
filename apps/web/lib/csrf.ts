/**
 * State-changing requests must come from this site: browsers always send `Origin` on form POSTs, and an attacker's page
 * cannot forge it. A missing or foreign Origin is rejected.
 */
export function sameOrigin(headers: Pick<Headers, "get">): boolean {
  const origin = headers.get("origin");
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The API throttles by client IP; behind the reverse proxy the real address arrives in X-Forwarded-For (first hop). */
export function clientIp(headers: Pick<Headers, "get">): string {
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first && /^[0-9a-fA-F:.]{3,45}$/.test(first) ? first : "0.0.0.0";
}

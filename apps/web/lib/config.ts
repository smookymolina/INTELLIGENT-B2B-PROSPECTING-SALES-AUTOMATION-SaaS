/** Server-side configuration. `API_URL` is never exposed to the browser (no NEXT_PUBLIC_ prefix). */
export function apiBase(env: Record<string, string | undefined> = process.env): string {
  const raw = env.API_URL ?? "http://127.0.0.1:3001";
  return `${raw.replace(/\/+$/, "")}/v1`;
}

/** Secure cookies (and the `__Host-` prefix) in production; plain names on http://localhost during development. */
export function cookieSecure(env: Record<string, string | undefined> = process.env): boolean {
  return env.SESSION_COOKIE_SECURE ? env.SESSION_COOKIE_SECURE === "true" : env.NODE_ENV === "production";
}

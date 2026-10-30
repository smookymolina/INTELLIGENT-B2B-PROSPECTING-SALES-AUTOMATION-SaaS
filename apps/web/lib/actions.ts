import type { ApiResult } from "./api";
import { sameOrigin } from "./csrf";
import { readSessionToken } from "./session";
import { see } from "./session-response";

/** Every state-changing form posts here first: same-origin check, session required, form parsed. */
export async function actionContext(request: Request): Promise<{ token: string; form: FormData } | Response> {
  if (!sameOrigin(request.headers)) return new Response("Forbidden", { status: 403 });
  const token = await readSessionToken();
  if (!token) return see("/login?error=expired");
  return { token, form: await request.formData() };
}

export const isResponse = (v: unknown): v is Response => v instanceof Response;

/** Small, fixed vocabulary shown to the user (never raw API text). */
export function failureCode(result: Extract<ApiResult<unknown>, { ok: false }>): string {
  switch (result.status) {
    case 0: return "unavailable";
    case 400: case 422: return "input";
    case 401: return "expired";
    case 403: return "forbidden";
    case 404: return "notfound";
    case 409: return "conflict";
    case 413: return "toolarge";
    case 429: return "rate";
    default: return result.status >= 500 ? "unavailable" : "unexpected";
  }
}

export function redirectWith(path: string, kind: "ok" | "error", code: string): Response {
  return see(`${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(code)}`);
}

/** "Name: value" per line -> features. Returns null when a line is malformed or names repeat (the API enforces the same). */
export function parseFeatures(text: string): Array<{ name: string; value: string }> | null {
  const out: Array<{ name: string; value: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(":");
    if (at < 1) return null;
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (!name || !value || out.some((f) => f.name.toLowerCase() === name.toLowerCase())) return null;
    out.push({ name, value });
  }
  return out;
}
export const featuresToText = (features: Array<{ name: string; value: string }>) => features.map((f) => `${f.name}: ${f.value}`).join("\n");

export const text = (form: FormData, name: string, max = 4000): string => {
  const v = form.get(name);
  return typeof v === "string" ? v.slice(0, max).trim() : "";
};
export const orNull = (v: string) => (v ? v : null);

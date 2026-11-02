import { apiBase } from "./config";
import { readSessionToken } from "./session";
import { see } from "./session-response";

/** Browsers send Sec-Fetch-Site on navigations; an export link followed from another site must not run with the user's cookie. */
export function sameSiteNavigation(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none"; // absent: non-browser client (tests, curl) - the session is still required
}

/** Streams an API CSV through the BFF. The bearer token never leaves the server; only whitelisted query parameters are forwarded. */
export async function proxyCsv(request: Request, apiPath: string, allowed: readonly string[], values: URLSearchParams): Promise<Response> {
  if (!sameSiteNavigation(request.headers)) return new Response("Forbidden", { status: 403 });
  const token = await readSessionToken();
  if (!token) return see("/login?error=expired");
  const query = new URLSearchParams();
  for (const key of allowed) {
    const v = values.get(key);
    if (v !== null && v !== "" && v.length <= 100) query.set(key, v);
  }
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${apiPath}?${query}`, { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${token}` } });
  } catch {
    return new Response("Service unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (res.status === 401) return see("/login?error=expired");
  if (!res.ok) return new Response("The export could not be created", { status: res.status === 403 ? 403 : res.status === 400 ? 400 : 502, headers: { "Cache-Control": "no-store" } });
  const headers = new Headers({ "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  for (const h of ["content-disposition", "x-export-truncated"]) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: 200, headers });
}

/** Streams one API PDF (quote) through the BFF: same-site navigation only, session required, never cached, no query forwarded. */
export async function proxyPdf(request: Request, apiPath: string): Promise<Response> {
  if (!sameSiteNavigation(request.headers)) return new Response("Forbidden", { status: 403 });
  const token = await readSessionToken();
  if (!token) return see("/login?error=expired");
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${apiPath}`, { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${token}`, accept: "application/pdf" } });
  } catch {
    return new Response("Service unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (res.status === 401) return see("/login?error=expired");
  if (!res.ok) return new Response("The document could not be created", { status: res.status === 403 ? 403 : res.status === 404 ? 404 : 502, headers: { "Cache-Control": "no-store" } });
  const headers = new Headers({ "Content-Type": "application/pdf", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  const disposition = res.headers.get("content-disposition");
  headers.set("Content-Disposition", disposition && /^attachment/i.test(disposition) ? disposition : 'attachment; filename="cotizacion.pdf"');
  return new Response(res.body, { status: 200, headers });
}

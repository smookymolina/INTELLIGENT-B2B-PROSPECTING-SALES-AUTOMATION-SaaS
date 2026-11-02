import { MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS, type McpConfig } from "./config.js";

export type ApiResult = { ok: true; status: number; data: unknown } | { ok: false; status: number; code: string; message: string };

const CODE_RE = /^[A-Za-z0-9_.:-]{1,60}$/;
const FALLBACK: Record<number, string> = {
  400: "Invalid request.",
  401: "Not authenticated: the API token was rejected.",
  403: "Forbidden: the token lacks permission.",
  404: "Not found.",
  409: "Conflict.",
  429: "Rate limited.",
};

/** Short, safe error derived from an API error body: never the raw body, headers or the token. */
export function sanitizeError(status: number, body: unknown, token: string): { code: string; message: string } {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const rawCode = [b["code"], b["error"]].find((v): v is string => typeof v === "string" && CODE_RE.test(v));
  const m = b["message"];
  let message = Array.isArray(m) ? m.filter((x): x is string => typeof x === "string").join("; ") : typeof m === "string" ? m : "";
  if (token) message = message.split(token).join("[redacted]");
  message = message.replace(/Bearer\s+\S+/gi, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 200);
  return { code: rawCode ?? `http_${status}`, message: message || FALLBACK[status] || "The API returned an error." };
}

export class ApiClient {
  constructor(
    private readonly cfg: McpConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request(method: "GET" | "POST", path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<ApiResult> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${this.cfg.apiUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.cfg.token}`,
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : null,
        signal: ctl.signal,
        redirect: "error",
      });
      const text = await readLimited(res);
      if (text === null) return { ok: false, status: res.status, code: "response_too_large", message: "The API response exceeded the size limit." };
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          return { ok: false, status: res.status, code: "invalid_response", message: "The API returned a non-JSON response." };
        }
      }
      if (!res.ok) return { ok: false, status: res.status, ...sanitizeError(res.status, parsed, this.cfg.token) };
      return { ok: true, status: res.status, data: parsed };
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      return { ok: false, status: 0, code: aborted ? "timeout" : "network_error", message: aborted ? "The API did not answer within 15 seconds." : "Could not reach the API." };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readLimited(res: Response): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

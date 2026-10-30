import type { ProblemDto } from "@prospecting/contracts";
import { apiBase } from "./config";

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; problem: ProblemDto | null };

type Init = { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; token?: string | null; body?: unknown; headers?: Record<string, string> };

/**
 * Server-side call to the API. Never cached (responses are per user), 10 s timeout, and failures are values, not exceptions:
 * status 0 means the API was unreachable. The token is only ever placed in the Authorization header.
 */
export async function api<T>(path: string, init: Init = {}): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: init.method ?? "GET",
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: {
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...init.headers,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : null,
    });
    const text = res.status === 204 ? "" : await res.text();
    const json: unknown = text ? safeJson(text) : null;
    if (res.ok) return { ok: true, status: res.status, data: json as T };
    return { ok: false, status: res.status, problem: isProblem(json) ? json : null };
  } catch {
    return { ok: false, status: 0, problem: null };
  }
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const isProblem = (v: unknown): v is ProblemDto => typeof v === "object" && v !== null && typeof (v as { code?: unknown }).code === "string";

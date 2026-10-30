import type { SessionDto } from "@prospecting/contracts";
import { NextResponse } from "next/server";
import type { ApiResult } from "./api";
import { sessionCookieName, sessionCookieOptions } from "./session";

/** 303 so the browser follows with GET after a form POST. Relative Location keeps working behind a reverse proxy. */
export function see(path: string, session?: SessionDto | "clear"): NextResponse {
  const res = new NextResponse(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });
  if (session === "clear") res.cookies.set(sessionCookieName(), "", { ...sessionCookieOptions(new Date(0)), maxAge: 0 });
  else if (session) res.cookies.set(sessionCookieName(), session.token, sessionCookieOptions(new Date(session.expiresAt)));
  return res;
}

/** Maps API failures to a small, non-revealing set of error codes shown by the login/register pages. */
export function errorCode(result: Extract<ApiResult<unknown>, { ok: false }>): "invalid" | "rate" | "input" | "conflict" | "unavailable" | "unexpected" {
  switch (result.status) {
    case 0: return "unavailable";
    case 400: return "input";
    case 401:
    case 403: return "invalid";
    case 409: return "conflict";
    case 422: return "input";
    case 429: return "rate";
    default: return result.status >= 500 ? "unavailable" : "unexpected";
  }
}

export const field = (form: FormData, name: string, max = 200): string => {
  const v = form.get(name);
  return typeof v === "string" ? v.slice(0, max) : "";
};

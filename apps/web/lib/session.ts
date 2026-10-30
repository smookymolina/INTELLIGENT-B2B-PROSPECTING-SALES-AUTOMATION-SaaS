import { cookies } from "next/headers";
import { cookieSecure } from "./config";

export const sessionCookieName = (secure: boolean = cookieSecure()) => (secure ? "__Host-session" : "session");

/**
 * The API bearer token lives ONLY in this httpOnly cookie, read by the Next.js server; browser JavaScript can never see it.
 * SameSite=Lax + the Origin check on every POST (see csrf.ts) protect the cookie from cross-site requests.
 */
export function sessionCookieOptions(expiresAt: Date, secure: boolean = cookieSecure()) {
  return { httpOnly: true, secure, sameSite: "lax" as const, path: "/", expires: expiresAt };
}

export async function readSessionToken(): Promise<string | null> {
  const value = (await cookies()).get(sessionCookieName())?.value;
  return value && /^[A-Za-z0-9_-]{20,128}$/.test(value) ? value : null;
}

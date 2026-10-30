import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { apiBase, cookieSecure } from "./config";
import { clientIp, sameOrigin } from "./csrf";
import { isCursor, pick } from "./format";
import { sessionCookieName, sessionCookieOptions } from "./session";

const h = (o: Record<string, string>) => new Headers(o);

describe("sameOrigin (CSRF)", () => {
  it("accepts only an Origin that matches the host", () => {
    expect(sameOrigin(h({ origin: "https://app.example.test", host: "app.example.test" }))).toBe(true);
    expect(sameOrigin(h({ origin: "https://evil.example.test", host: "app.example.test" }))).toBe(false);
    expect(sameOrigin(h({ origin: "https://app.example.test.evil.test", host: "app.example.test" }))).toBe(false);
    expect(sameOrigin(h({ host: "app.example.test" }))).toBe(false); // no Origin => rejected
    expect(sameOrigin(h({ origin: "null", host: "app.example.test" }))).toBe(false);
    expect(sameOrigin(h({ origin: "not a url", host: "app.example.test" }))).toBe(false);
  });
  it("honours X-Forwarded-Host behind the proxy", () => {
    expect(sameOrigin(h({ origin: "https://public.example.test", host: "internal:3000", "x-forwarded-host": "public.example.test" }))).toBe(true);
  });
});

describe("clientIp", () => {
  it("takes the first forwarded hop and rejects junk", () => {
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientIp(h({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientIp(h({ "x-forwarded-for": "<script>" }))).toBe("0.0.0.0");
    expect(clientIp(h({}))).toBe("0.0.0.0");
  });
});

describe("session cookie", () => {
  it("is httpOnly, SameSite=Lax, path / and __Host- prefixed when secure", () => {
    const exp = new Date("2030-01-01T00:00:00Z");
    expect(sessionCookieOptions(exp, true)).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/", expires: exp });
    expect(sessionCookieName(true)).toBe("__Host-session");
    expect(sessionCookieName(false)).toBe("session");
  });
});

describe("config", () => {
  it("builds the API base and decides cookie security from the environment", () => {
    expect(apiBase({ API_URL: "http://api.internal:3001/" })).toBe("http://api.internal:3001/v1");
    expect(apiBase({})).toBe("http://127.0.0.1:3001/v1");
    expect(cookieSecure({ NODE_ENV: "production" })).toBe(true);
    expect(cookieSecure({ NODE_ENV: "development" })).toBe(false);
    expect(cookieSecure({ NODE_ENV: "production", SESSION_COOKIE_SECURE: "false" })).toBe(false);
  });
});

describe("format helpers", () => {
  it("only lets known filter values and well-formed cursors through", () => {
    expect(pick("approved", ["all", "approved"] as const)).toBe("approved");
    expect(pick("DROP TABLE", ["all", "approved"] as const)).toBeUndefined();
    expect(pick(["draft", "x"], ["draft"] as const)).toBe("draft");
    expect(isCursor("sku-1.a_b")).toBe(true);
    expect(isCursor("UPPER")).toBe(false);
    expect(isCursor("a b")).toBe(false);
    expect(isCursor(undefined)).toBe(false);
  });
});

describe("api()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the token only in Authorization, never caches, and returns data", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await api<{ ok: number }>("/me", { token: "tok_abcdefghijklmnopqrstuvwxyz" });
    expect(res).toEqual({ ok: true, status: 200, data: { ok: 1 } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3001/v1/me");
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok_abcdefghijklmnopqrstuvwxyz");
    expect(url).not.toContain("tok_");
  });

  it("returns the error envelope as a value, handles 204, non-JSON errors and network failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "FORBIDDEN", message: "x", details: null, request_id: "r" }), { status: 403 })));
    expect(await api("/x")).toMatchObject({ ok: false, status: 403, problem: { code: "FORBIDDEN" } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    expect(await api("/x", { method: "POST" })).toEqual({ ok: true, status: 204, data: null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })));
    expect(await api("/x")).toEqual({ ok: false, status: 502, problem: null });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await api("/x")).toEqual({ ok: false, status: 0, problem: null });
  });

  it("serializes JSON bodies with a content type", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await api("/auth/login", { method: "POST", body: { a: 1 } });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });
});

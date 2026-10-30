import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Api, PASSWORD, startApi } from "./harness.js";

/** P12-02: readiness probe and token-protected metrics. */
let api: Api;
const TOKEN = "metrics-token-0123456789-abcdefghijklmnop";

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  delete process.env.METRICS_TOKEN;
  await api.close();
});

const raw = async (path: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`${await api.app.getUrl()}/v1${path}`, { headers });
  return { status: res.status, text: await res.text(), type: res.headers.get("content-type") ?? "" };
};

describe("readiness", () => {
  it("is public, answers 200 while the database is reachable and carries no detail", async () => {
    const res = await api.call("GET", "/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready" });
    expect((await api.call("GET", "/health")).body).toEqual({ status: "ok", service: "api" });
  });
});

describe("metrics", () => {
  it("is disabled (404) until METRICS_TOKEN is configured", async () => {
    delete process.env.METRICS_TOKEN;
    expect((await raw("/health/metrics", { authorization: `Bearer ${TOKEN}` })).status).toBe(404);
  });

  it("requires the bearer token (same 404 for wrong or missing) and exposes only bounded, tenant-free series", async () => {
    process.env.METRICS_TOKEN = TOKEN;
    await api.call("POST", "/auth/login", { body: { email: "nobody@example.test", password: PASSWORD } });
    expect((await raw("/health/metrics")).status).toBe(404);
    expect((await raw("/health/metrics", { authorization: "Bearer wrong" })).status).toBe(404);
    expect((await raw("/health/metrics", { authorization: `Bearer ${TOKEN}x` })).status).toBe(404);
    const ok = await raw("/health/metrics", { authorization: `Bearer ${TOKEN}` });
    expect(ok.status).toBe(200);
    expect(ok.type).toContain("text/plain");
    expect(ok.text).toMatch(/http_requests_total\{method="POST",route="\/v1\/auth\/login",status="4xx"\} \d+/);
    expect(ok.text).toContain("process_uptime_seconds");
    expect(ok.text).not.toContain("nobody@example.test");
    expect(ok.text).not.toContain(TOKEN);
  });

  it("labels routes by pattern, never by raw URL", async () => {
    process.env.METRICS_TOKEN = TOKEN;
    await api.call("GET", "/auth/sessions/not-a-uuid", { token: "x" });
    await raw("/definitely/not/a/route?secret=abc");
    const text = (await raw("/health/metrics", { authorization: `Bearer ${TOKEN}` })).text;
    expect(text).toContain('route="unmatched"');
    expect(text).not.toContain("secret=abc");
    expect(text).not.toContain("not-a-uuid");
  });
});

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AnthropicProvider } from "./anthropic.provider.js";
import { AiProviders, costMicros } from "./providers.js";

const KEY = "test-key-not-real";
const SECRET_PROMPT = "PROMPT-SECRETO-123";
const req = { system: "sys", user: `user ${SECRET_PROMPT}`, maxOutputTokens: 600, timeoutMs: 2000 };

type Seen = { url: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> };
let server: Server;
let seen: Seen[] = [];
let handler: (res: ServerResponse) => void;
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const ok = (over: Record<string, unknown> = {}) => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn",
  content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"summary":"a"' }, { type: "text", text: "}" }],
  usage: { input_tokens: 123, output_tokens: 45 },
  ...over,
});

const ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_BASE_URL", "AI_PROVIDER", "AI_FALLBACK_PROVIDER"] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  server = createServer((r, res) => {
    let raw = "";
    r.on("data", (c) => (raw += c));
    r.on("end", () => {
      seen.push({ url: r.url ?? "", headers: r.headers, body: JSON.parse(raw || "{}") as Record<string, unknown> });
      handler(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  seen = [];
  handler = (res) => json(res, 200, ok());
  process.env.ANTHROPIC_API_KEY = KEY;
  delete process.env.ANTHROPIC_MODEL;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const failure = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(Error);
  const msg = `${(e as Error).message}\n${(e as Error).stack ?? ""}\n${String((e as Error).cause ?? "")}`;
  expect(msg).not.toContain(KEY);
  expect(msg).not.toContain(SECRET_PROMPT);
  return (e as Error).message;
};

describe("AnthropicProvider", () => {
  const provider = new AnthropicProvider();

  it("calls the Messages API and returns the text with the real usage", async () => {
    const out = await provider.complete(req);
    expect(out).toEqual({ text: '{"summary":"a"}', model: "claude-opus-5-5", inputTokens: 123, outputTokens: 45 });
    expect(seen).toHaveLength(1);
    const call = seen[0] as Seen;
    expect(call.url).toBe("/v1/messages");
    expect(call.headers["x-api-key"]).toBe(KEY);
    expect(call.headers["anthropic-version"]).toBe("2026-10-21");
    expect(call.body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 600, system: "sys", messages: [{ role: "user", content: req.user }] });
    expect(costMicros(out.model, out.inputTokens, out.outputTokens)).toBe(492 + 900);
  });

  it("uses ANTHROPIC_MODEL, read at call time, and counts cached input tokens", async () => {
    process.env.ANTHROPIC_MODEL = "claude-sonnet-5-5";
    handler = (res) => json(res, 200, ok({ model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 7 } }));
    const out = await provider.complete(req);
    expect((seen[0] as Seen).body.model).toBe("claude-sonnet-5-5");
    expect(out).toMatchObject({ model: "claude-sonnet-5-5", inputTokens: 17, outputTokens: 7 });
  });

  it("refuses a model without a configured rate before calling out", async () => {
    process.env.ANTHROPIC_MODEL = "claude-unrated-x";
    expect(await failure(provider.complete(req))).toContain("no configured rate");
    expect(seen).toHaveLength(0);
  });

  it.each([[429, "rate_limit_error"], [500, "api_error"]])("turns HTTP %i into a clean error", async (status, type) => {
    handler = (res) => json(res, status, { type: "error", error: { type, message: `echo ${SECRET_PROMPT} ${KEY}` } });
    expect(await failure(provider.complete(req))).toBe(`Anthropic API error: HTTP ${status} (${type})`);
  });

  it("handles a non-JSON error body and a malformed success body", async () => {
    handler = (res) => { res.writeHead(502); res.end("<html>bad gateway</html>"); };
    expect(await failure(provider.complete(req))).toBe("Anthropic API error: HTTP 502");
    handler = (res) => json(res, 200, { content: "nope" });
    expect(await failure(provider.complete(req))).toContain("unexpected response");
  });

  it("fails on a refusal", async () => {
    handler = (res) => json(res, 200, ok({ stop_reason: "refusal", content: [] }));
    expect(await failure(provider.complete(req))).toContain("declined");
  });

  it("aborts at timeoutMs", async () => {
    handler = () => undefined; // never answers
    const started = Date.now();
    expect(await failure(provider.complete({ ...req, timeoutMs: 100 }))).toBe("Anthropic request timed out after 100 ms");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("reports a network failure without leaking anything", async () => {
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
    expect(await failure(provider.complete(req))).toBe("Anthropic request failed: network error");
  });

  it("is unusable without a key: complete() throws and the chain answers 503", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(await failure(provider.complete(req))).toContain("not configured");
    expect(seen).toHaveLength(0);
    const providers = new AiProviders();
    expect(() => providers.chain({ AI_PROVIDER: "anthropic" })).toThrowError(expect.objectContaining({ status: 503 }));
    expect(() => providers.chain({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "  " })).toThrowError(expect.objectContaining({ status: 503 }));
    expect(providers.chain({ AI_PROVIDER: "anthropic", AI_FALLBACK_PROVIDER: "mock" }).map((p) => p.name)).toEqual(["mock"]);
    expect(providers.chain({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: KEY }).map((p) => p.name)).toEqual(["anthropic"]);
  });
});

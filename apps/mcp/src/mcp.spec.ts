import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiClient, sanitizeError } from "./client.js";
import { loadConfig } from "./config.js";
import { GetDraftStatusInput, GetOutreachContextInput, SaveMessageDraftInput } from "./tools.js";

const TOKEN = "tok_super_secret_123";

describe("loadConfig", () => {
  it("requires a token and never echoes it", () => {
    expect(() => loadConfig({})).toThrow(/MCP_API_TOKEN/);
    expect(() => loadConfig({ MCP_API_TOKEN: TOKEN, MCP_API_URL: "ftp://x" })).toThrow(/http/);
  });
  it("defaults to local and rejects remote hosts unless allowed", () => {
    expect(loadConfig({ MCP_API_TOKEN: TOKEN }).apiUrl).toBe("http://127.0.0.1:3001/v1");
    expect(loadConfig({ MCP_API_TOKEN: TOKEN, MCP_API_URL: "http://localhost:4000/v1/" }).apiUrl).toBe("http://localhost:4000/v1");
    let msg = "";
    try {
      loadConfig({ MCP_API_TOKEN: TOKEN, MCP_API_URL: "https://api.example.com/v1" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/MCP_ALLOW_REMOTE/);
    expect(msg).not.toContain(TOKEN);
    expect(loadConfig({ MCP_API_TOKEN: TOKEN, MCP_API_URL: "https://api.example.com/v1", MCP_ALLOW_REMOTE: "1" }).apiUrl).toBe("https://api.example.com/v1");
    expect(() => loadConfig({ MCP_API_TOKEN: TOKEN, MCP_API_URL: "http://user:pw@127.0.0.1/v1" })).toThrow(/credentials/);
  });
});

describe("sanitizeError", () => {
  it("keeps a short code and message, and redacts tokens and bearer values", () => {
    const e = sanitizeError(400, { code: "validation_error", message: `bad ${TOKEN} Bearer abc.def`, stack: "secret stack", headers: { a: 1 } }, TOKEN);
    expect(e.code).toBe("validation_error");
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).not.toContain("abc.def");
    expect(JSON.stringify(e)).not.toContain("stack");
  });
  it("falls back to http_<status> and truncates long messages", () => {
    expect(sanitizeError(401, null, TOKEN)).toMatchObject({ code: "http_401" });
    expect(sanitizeError(500, { message: "x".repeat(1000) }, TOKEN).message).toHaveLength(200);
    expect(sanitizeError(400, { message: ["a", "b"] }, TOKEN).message).toBe("a; b");
  });
});

describe("tool input validation", () => {
  const save = z.object(SaveMessageDraftInput);
  const id = "11111111-1111-4111-8111-111111111111";
  it("accepts a valid draft and rejects bad channel, NUL, oversize and missing fields", () => {
    expect(save.safeParse({ contactId: id, channel: "email", subject: "Hola", body: "Texto", evidenceRefs: [] }).success).toBe(true);
    expect(save.safeParse({ contactId: id, channel: "sms", body: "x", evidenceRefs: [] }).success).toBe(false);
    expect(save.safeParse({ contactId: id, channel: "email", body: "a\u0000b", evidenceRefs: [] }).success).toBe(false);
    expect(save.safeParse({ contactId: id, channel: "email", body: "x".repeat(5001), evidenceRefs: [] }).success).toBe(false);
    expect(save.safeParse({ contactId: "nope", channel: "email", body: "x", evidenceRefs: [] }).success).toBe(false);
    expect(save.safeParse({ contactId: id, channel: "email", body: "x" }).success).toBe(false);
  });
  it("requires UUIDs for the read tools", () => {
    expect(z.object(GetOutreachContextInput).safeParse({ contactId: "x" }).success).toBe(false);
    expect(z.object(GetDraftStatusInput).safeParse({ draftId: id }).success).toBe(true);
  });
});

describe("ApiClient", () => {
  const cfg = { apiUrl: "http://127.0.0.1:1/v1", token: TOKEN };
  it("sends the bearer token only as a header and sanitises API errors", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const f = (async (url: string, init: { headers: Record<string, string> }) => {
      seen = { url, headers: init.headers };
      return new Response(JSON.stringify({ message: `nope ${TOKEN}`, trace: "x" }), { status: 403 });
    }) as unknown as typeof fetch;
    const r = await new ApiClient(cfg, f).request("GET", "/message-drafts/abc");
    expect(seen?.url).not.toContain(TOKEN);
    expect(seen?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(r).toMatchObject({ ok: false, status: 403, code: "http_403" });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
  it("rejects oversize responses and reports network failures without details", async () => {
    const big = (async () => new Response("x".repeat(300 * 1024), { status: 200 })) as unknown as typeof fetch;
    expect(await new ApiClient(cfg, big).request("GET", "/x")).toMatchObject({ ok: false, code: "response_too_large" });
    const down = (async () => {
      throw new Error(`connect failed ${TOKEN}`);
    }) as unknown as typeof fetch;
    const r = await new ApiClient(cfg, down).request("GET", "/x");
    expect(r).toMatchObject({ ok: false, code: "network_error" });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

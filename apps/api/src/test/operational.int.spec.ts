import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ERROR_CODES, ProblemDto } from "@prospecting/contracts";
import { PrismaService } from "../db/prisma.service.js";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** P2-13: uniform error envelope, server-generated request ids, Idempotency-Key. */
let api: Api;
let token: string;
let orgId: string;
let membershipId: string;

const regBody = () => ({ email: `op-${randomUUID().slice(0, 8)}@example.test`, password: PASSWORD, displayName: "op", organizationName: "Operational Org" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const usersWithEmail = async (email: string) => Number((await owner.query("SELECT count(*) AS n FROM users WHERE email = $1", [email])).rows[0].n);
const openClaims = async () => Number((await owner.query("SELECT count(*) AS n FROM idempotency_keys WHERE completed_at IS NULL")).rows[0].n);

beforeAll(async () => {
  api = await startApi();
  const res = await api.call("POST", "/auth/register", { body: regBody() });
  token = res.body.token;
  orgId = res.body.organization.id;
  membershipId = (await api.call("GET", "/memberships", { token })).body[0].id;
});
afterAll(async () => {
  await api.close();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function expectProblem(res: { status: number; body: any; headers: Headers }, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(Object.keys(res.body).sort()).toEqual(["code", "details", "message", "request_id"]);
  expect(res.body.code).toBe(code);
  expect(ERROR_CODES).toContain(res.body.code);
  expect(res.body.request_id).toMatch(UUID);
  expect(res.headers.get("x-request-id")).toBe(res.body.request_id);
  expect(ProblemDto.safeParse(res.body).success).toBe(true);
}

describe("error envelope", () => {
  it("validation (400) lists issues without echoing submitted values", async () => {
    const res = await api.call("POST", "/auth/register", { body: { ...regBody(), password: "tiny-pw-1" } });
    expectProblem(res, 400, "VALIDATION_FAILED");
    expect(res.body.details.issues).toEqual([{ path: "password", code: "too_small" }]);
    expect(JSON.stringify(res.body)).not.toContain("tiny-pw-1");
  });

  it("malformed JSON is rejected (400) inside the envelope", async () => {
    const res = await fetch(`${await api.app.getUrl()}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(body.request_id).toMatch(UUID);
  });

  it("auth (401), not found (404), conflict (409)", async () => {
    expectProblem(await api.call("GET", "/me"), 401, "UNAUTHENTICATED");
    expectProblem(await api.call("GET", "/audit-events", { token: "x".repeat(43) }), 401, "UNAUTHENTICATED");
    expectProblem(await api.call("PATCH", `/memberships/${randomUUID()}`, { token, body: { role: "viewer" } }), 404, "NOT_FOUND");
    expectProblem(await api.call("GET", "/does-not-exist"), 404, "NOT_FOUND");
    expectProblem(await api.call("PATCH", `/memberships/${membershipId}`, { token, body: { role: "viewer" } }), 409, "CONFLICT");
  });

  it("forbidden (403) for a role without the permission", async () => {
    const seeded = await seedMember(orgId, "viewer");
    const login = await api.call("POST", "/auth/login", { body: { email: seeded.email, password: PASSWORD } });
    expectProblem(await api.call("GET", "/audit-events", { token: login.body.token }), 403, "FORBIDDEN");
  });

  it("rate limiting (429) carries Retry-After and details", async () => {
    const email = `rl-${randomUUID().slice(0, 8)}@example.test`;
    const attempt = () => api.call("POST", "/auth/login", { body: { email, password: "wrong wrong wrong" }, headers: { "x-forwarded-for": "10.9.9.9" } });
    for (let i = 0; i < 5; i++) await attempt();
    const blocked = await attempt();
    expectProblem(blocked, 429, "RATE_LIMITED");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(blocked.body.details.retryAfterSeconds).toBe(Number(blocked.headers.get("retry-after")));
  });

  it("unexpected errors become a generic 500 and never leak internals", async () => {
    const prisma = api.app.get(PrismaService);
    const spy = vi.spyOn(prisma, "withTenant").mockRejectedValueOnce(new Error("password=hunter2 SELECT * FROM secrets"));
    const res = await api.call("GET", "/organization", { token });
    spy.mockRestore();
    expectProblem(res, 500, "INTERNAL_ERROR");
    expect(res.body.message).toBe("Internal server error");
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|SELECT/);
  });
});

describe("request id", () => {
  it("is server-generated, unique, present on success, and ignores client-supplied values", async () => {
    const forged = randomUUID();
    const a = await api.call("GET", "/health", { headers: { "x-request-id": forged } });
    const b = await api.call("GET", "/health");
    expect(a.headers.get("x-request-id")).toMatch(UUID);
    expect(a.headers.get("x-request-id")).not.toBe(forged);
    expect(a.headers.get("x-request-id")).not.toBe(b.headers.get("x-request-id"));
  });

  it("is the one written to the audit trail", async () => {
    const res = await api.call("PATCH", "/organization", { token, body: { name: "Request Id Org" } });
    const rid = res.headers.get("x-request-id");
    const { rows } = await owner.query("SELECT 1 FROM audit_events WHERE request_id = $1 AND action = 'organization.updated'", [rid]);
    expect(rows).toHaveLength(1);
  });
});

describe("Idempotency-Key (register)", () => {
  const post = (body: unknown, key?: string) => api.call("POST", "/auth/register", { body, ...(key ? { headers: { "idempotency-key": key } } : {}) });

  it("replays the same result for the same key and request, creating the account once", async () => {
    const body = regBody();
    const key = `key-${randomUUID()}`;
    const first = await post(body, key);
    const second = await post(body, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(await usersWithEmail(body.email)).toBe(1);
    expect((await api.call("GET", "/me", { token: second.body.token })).status).toBe(200);
  });

  it("rejects the same key with a different request (422) without creating anything", async () => {
    const key = `key-${randomUUID()}`;
    await post(regBody(), key);
    const other = regBody();
    expectProblem(await post(other, key), 422, "IDEMPOTENCY_KEY_REUSED");
    expect(await usersWithEmail(other.email)).toBe(0);
  });

  it("handles concurrent duplicates: one account, the rest replay or get 409", async () => {
    const body = regBody();
    const key = `key-${randomUUID()}`;
    const results = await Promise.all([post(body, key), post(body, key), post(body, key)]);
    expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(await usersWithEmail(body.email)).toBe(1);
  });

  it("does not cache failures: the claim is released", async () => {
    const existing = regBody();
    expect((await post(existing)).status).toBe(201);
    const before = await openClaims();
    expectProblem(await post(existing, `key-${randomUUID()}`), 409, "CONFLICT");
    expect(await openClaims()).toBe(before);
  });

  it("validates the key format and works without a key", async () => {
    expectProblem(await post(regBody(), "short"), 400, "VALIDATION_FAILED");
    expect((await post(regBody())).status).toBe(201);
  });

  it("stores only hashed keys and encrypted results (no token in clear), unreadable by the runtime role", async () => {
    const key = `key-${randomUUID()}`;
    const res = await post(regBody(), key);
    const { rows } = await owner.query("SELECT key_hash, response_ciphertext FROM idempotency_keys ORDER BY created_at DESC LIMIT 1");
    expect(rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].key_hash).not.toContain(key);
    expect(rows[0].response_ciphertext).toMatch(/^v1\./);
    expect(rows[0].response_ciphertext).not.toContain(res.body.token);
    await asRuntime({}, async (c) => {
      await expect(c.query("SELECT * FROM idempotency_keys")).rejects.toThrow(/permission denied/);
    });
  });
});

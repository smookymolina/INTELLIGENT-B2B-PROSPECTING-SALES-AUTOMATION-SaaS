import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Api, asRuntime, owner, PASSWORD, randomIp, sameShape, startApi } from "./harness.js";

/** P2-12: distributed (PostgreSQL-backed) login throttling. Each test uses its own client IPs so they do not interfere. */
let api: Api;
const login = (email: string, password: string, ip: string) =>
  api.call("POST", "/auth/login", { body: { email, password }, headers: { "x-forwarded-for": ip } });

async function newAccount(): Promise<string> {
  const email = `throttle-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: "t", organizationName: "Throttle Org" } });
  expect(res.status).toBe(201);
  return email;
}
const attemptsFor = async (email: string) => {
  // Same keyed hash the server uses is not exposed, so count via the account's recent rows by elimination is impossible; use totals instead.
  void email;
  return Number((await owner.query("SELECT count(*) AS n FROM login_attempts")).rows[0].n);
};

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("per-account limit", () => {
  it("blocks the 6th failed attempt, even from a new IP and even with the right password", async () => {
    const email = await newAccount();
    for (let i = 0; i < 5; i++) expect((await login(email, "wrong wrong wrong", randomIp())).status).toBe(401);
    const blocked = await login(email, "wrong wrong wrong", randomIp());
    expect(blocked.status).toBe(429);
    expect((await login(email, PASSWORD, randomIp())).status).toBe(429);
  });

  it("does not reveal whether the email exists (same statuses and bodies before and after the threshold)", async () => {
    const real = await newAccount();
    const ghost = `ghost-${randomUUID().slice(0, 8)}@example.test`;
    const before = await Promise.all([login(real, "wrong wrong wrong", randomIp()), login(ghost, "wrong wrong wrong", randomIp())]);
    expect(sameShape(before[0]!)).toEqual(sameShape(before[1]!));
    for (let i = 0; i < 4; i++) {
      await login(real, "wrong wrong wrong", randomIp());
      await login(ghost, "wrong wrong wrong", randomIp());
    }
    const after = await Promise.all([login(real, "wrong wrong wrong", randomIp()), login(ghost, "wrong wrong wrong", randomIp())]);
    expect(after.map((r) => r.status)).toEqual([429, 429]);
    expect(sameShape(after[0]!)).toEqual(sameShape(after[1]!));
  });

  it("a successful login clears the account's failures", async () => {
    const email = await newAccount();
    for (let i = 0; i < 4; i++) expect((await login(email, "wrong wrong wrong", randomIp())).status).toBe(401);
    expect((await login(email, PASSWORD, randomIp())).status).toBe(200);
    // 4 more failures would have crossed the threshold (4 + 4 > 5) had the counter not been reset.
    for (let i = 0; i < 4; i++) expect((await login(email, "wrong wrong wrong", randomIp())).status).toBe(401);
  });

  it("is atomic under concurrency: exactly 5 of 10 parallel failures are evaluated", async () => {
    const email = await newAccount();
    const results = await Promise.all(Array.from({ length: 10 }, () => login(email, "wrong wrong wrong", randomIp())));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  });
});

describe("per-IP limit", () => {
  it("blocks the 21st failure from one IP across different accounts, while other IPs are unaffected", async () => {
    const ip = randomIp();
    for (let i = 0; i < 20; i++) expect((await login(`spray-${i}-${randomUUID().slice(0, 6)}@example.test`, "wrong wrong wrong", ip)).status).toBe(401);
    expect((await login("another@example.test", "wrong wrong wrong", ip)).status).toBe(429);
    const email = await newAccount();
    expect((await login(email, PASSWORD, ip)).status).toBe(429); // a valid login from the throttled IP is also refused
    expect((await login(email, PASSWORD, randomIp())).status).toBe(200);
  }, 30_000);
});

describe("window, retention and storage", () => {
  it("unblocks when attempts age out of the 15 minute window", async () => {
    const email = await newAccount();
    for (let i = 0; i < 5; i++) await login(email, "wrong wrong wrong", randomIp());
    expect((await login(email, PASSWORD, randomIp())).status).toBe(429);
    await owner.query("UPDATE login_attempts SET created_at = now() - interval '16 minutes' WHERE created_at > now() - interval '1 minute'");
    expect((await login(email, PASSWORD, randomIp())).status).toBe(200);
  });

  it("prunes attempts older than the 24 hour retention", async () => {
    const stale = randomUUID();
    await owner.query("INSERT INTO login_attempts (id, ip_hash, account_hash, created_at) VALUES ($1,'x','y', now() - interval '25 hours')", [stale]);
    await login(`prune-${randomUUID().slice(0, 6)}@example.test`, "wrong wrong wrong", randomIp());
    expect((await owner.query("SELECT 1 FROM login_attempts WHERE id = $1", [stale])).rowCount).toBe(0);
  });

  it("stores only keyed hashes (no raw IP/email) and the table is unreadable by the runtime role", async () => {
    const ip = randomIp();
    const email = `store-${randomUUID().slice(0, 6)}@example.test`;
    await login(email, "wrong wrong wrong", ip);
    const { rows } = await owner.query("SELECT ip_hash, account_hash FROM login_attempts ORDER BY created_at DESC LIMIT 1");
    expect(rows[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].account_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(ip);
    expect(JSON.stringify(rows)).not.toContain(email);
    await asRuntime({}, async (c) => {
      await expect(c.query("SELECT * FROM login_attempts")).rejects.toThrow(/permission denied/);
    });
    expect(await attemptsFor(email)).toBeGreaterThan(0);
  });
});

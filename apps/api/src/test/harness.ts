import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import type { MembershipRole } from "@prospecting/contracts";
import { AppModule } from "../app.module.js";
import { configureApp } from "../app.setup.js";
import { hashPassword } from "../auth/password.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://app:app@localhost:5432/prospecting_test";
if (!/_test$/.test(new URL(TEST_DATABASE_URL).pathname.slice(1))) throw new Error("Integration tests only run against a *_test database");
process.env.DATABASE_URL = TEST_DATABASE_URL;
// Throwaway secrets for tests only.
process.env.HMAC_SECRET ??= "test-only-hmac-secret-0123456789abcdef";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.TRUST_PROXY = "1"; // lets each test present its own client IP via X-Forwarded-For

export const randomIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

/** Owner connection (superuser in dev): used only to seed fixtures and to inspect raw state. Never used by the app under test. */
export const owner = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });

export const PASSWORD = "correct horse battery staple";
export type Ctx = { organizationId?: string | undefined; userId?: string | undefined; role?: string | undefined };

/** Runs `fn` as `app_runtime` with the given RLS context, always rolling back so tests never leak state. */
export async function asRuntime<T>(ctx: Ctx, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE app_runtime");
    await c.query("SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', $3, true)", [
      ctx.organizationId ?? "",
      ctx.userId ?? "",
      ctx.role ?? "",
    ]);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

export type Seeded = { userId: string; email: string; membershipId: string };

export async function seedOrganization(label: string): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  const slug = `${label}-${id.slice(0, 8)}`;
  await owner.query("INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $2, $3, now())", [id, `Org ${label}`, slug]);
  return { id, slug };
}

export async function seedUser(label: string): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@example.test`;
  await owner.query("INSERT INTO users (id, email, password_hash, display_name, updated_at) VALUES ($1, $2, $3, $4, now())", [
    id,
    email,
    await hashPassword(PASSWORD),
    label,
  ]);
  return { id, email };
}

export async function seedMember(organizationId: string, role: MembershipRole, label: string = role): Promise<Seeded> {
  const user = await seedUser(label);
  const membershipId = randomUUID();
  await owner.query("INSERT INTO memberships (id, organization_id, user_id, role, updated_at) VALUES ($1, $2, $3, $4, now())", [
    membershipId,
    organizationId,
    user.id,
    role,
  ]);
  return { userId: user.id, email: user.email, membershipId };
}

/** Compare responses across requests: request ids legitimately differ. */
export const sameShape = (r: { status: number; body: unknown }) => ({ status: r.status, body: { ...(r.body as object), request_id: undefined } });

export type Api = {
  app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call(method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: any; headers: Headers }>;
  close(): Promise<void>;
};

export async function startApi(): Promise<Api> {
  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  const base = await app.getUrl();
  return {
    app,
    async call(method, path, opts = {}) {
      const res = await fetch(`${base}/v1${path}`, {
        method,
        headers: {
          "x-forwarded-for": randomIp(),
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : null,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    },
    async close() {
      await app.close();
      await owner.end();
    },
  };
}

import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { MembershipRole } from "@prospecting/contracts";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/prisma/client.js";

export type Tx = Prisma.TransactionClient;

/** Tenant identity. Built ONLY from a verified session (or from ids the server just generated); never from request input. */
export type TenantContext = Readonly<{ organizationId: string; userId: string; role: MembershipRole }>;

@Injectable()
export class PrismaService implements OnModuleDestroy {
  private readonly client: PrismaClient;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required");
    this.client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  }

  /** Runs `fn` in one transaction as the unprivileged `app_runtime` role with the tenant context set (RLS applies). */
  withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>, options: { timeoutMs?: number } = {}): Promise<T> {
    return this.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_runtime`;
        await tx.$queryRaw`SELECT set_config('app.organization_id', ${ctx.organizationId}, true),
          set_config('app.user_id', ${ctx.userId}, true), set_config('app.role', ${ctx.role}, true)`;
        return fn(tx);
      },
      { timeout: options.timeoutMs ?? 10_000 },
    );
  }

  /** Pre-tenant access (login/session lookup): `app_runtime` without context, so only the auth_* SECURITY DEFINER functions are useful. */
  withoutTenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_runtime`;
        return fn(tx);
      },
      { timeout: 10_000 },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}

export { Prisma };

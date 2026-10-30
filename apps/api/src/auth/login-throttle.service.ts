import { createHmac } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ApiException } from "../http/api-exception.js";
import { PrismaService } from "../db/prisma.service.js";
import { loadSecurityConfig } from "../config/security.config.js";

/** Policy (ADR-013): sliding 15 min window; 5 unresolved attempts per account or 20 per IP => blocked until the oldest attempt ages out. */
export const LOGIN_POLICY = { windowSeconds: 15 * 60, accountMax: 5, ipMax: 20 } as const;

export class RateLimitedException extends ApiException {
  constructor(readonly retryAfterSeconds: number) {
    super(429, "RATE_LIMITED", "Too many attempts. Try again later.", { retryAfterSeconds }, { "Retry-After": String(retryAfterSeconds) });
  }
}

type BeginRow = { allowed: boolean; retry_after_seconds: number; attempt_id: string | null };

@Injectable()
export class LoginThrottleService {
  private readonly secret = loadSecurityConfig().hmacSecret;

  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  /** Keyed hash with domain separation: raw IPs/emails are never stored, and hashes are useless without the server secret. */
  private hash(domain: "ip" | "acct", value: string): string {
    return createHmac("sha256", this.secret).update(`${domain}:${value}`).digest("hex");
  }

  /**
   * Called BEFORE any account lookup so the outcome is identical whether or not the email exists.
   * Records the attempt atomically; the caller must call `succeeded` to clear it.
   */
  async begin(ip: string, email: string): Promise<{ attemptId: string; accountHash: string }> {
    const accountHash = this.hash("acct", email);
    const { windowSeconds, accountMax, ipMax } = LOGIN_POLICY;
    const rows = await this.db.withoutTenant(
      (tx) =>
        tx.$queryRaw<BeginRow[]>`SELECT * FROM auth_login_begin(${this.hash("ip", ip)}, ${accountHash}, ${windowSeconds}::int, ${ipMax}::int, ${accountMax}::int)`,
    );
    const row = rows[0];
    if (!row?.allowed || !row.attempt_id) throw new RateLimitedException(Math.max(1, row?.retry_after_seconds ?? windowSeconds));
    return { attemptId: row.attempt_id, accountHash };
  }

  async succeeded(attemptId: string, accountHash: string): Promise<void> {
    await this.db.withoutTenant((tx) => tx.$executeRaw`SELECT auth_login_succeeded(${attemptId}::uuid, ${accountHash})`);
  }
}

import { Inject, Injectable } from "@nestjs/common";
import type { HealthStatus } from "@prospecting/contracts";
import { PrismaService } from "../db/prisma.service.js";

@Injectable()
export class HealthService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  getStatus(): HealthStatus {
    return { status: "ok", service: "api" };
  }

  /** A trivial query through the same pool the app uses; any failure or a 2 s stall means "not ready". */
  async databaseReachable(): Promise<boolean> {
    try {
      await Promise.race([
        this.db.withoutTenant((tx) => tx.$queryRaw`SELECT 1`),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000).unref()),
      ]);
      return true;
    } catch {
      return false;
    }
  }
}

import { describe, expect, it } from "vitest";
import type { PrismaService } from "../db/prisma.service.js";
import { HealthService } from "./health.service.js";

const dbWith = (withoutTenant: () => Promise<unknown>) => ({ withoutTenant }) as unknown as PrismaService;

describe("HealthService", () => {
  it("reports API health", () => {
    expect(new HealthService(dbWith(async () => 1)).getStatus()).toEqual({ status: "ok", service: "api" });
  });

  it("is ready only while the database answers", async () => {
    expect(await new HealthService(dbWith(async () => 1)).databaseReachable()).toBe(true);
    expect(await new HealthService(dbWith(async () => { throw new Error("connection refused: postgres://secret"); })).databaseReachable()).toBe(false);
  });
});

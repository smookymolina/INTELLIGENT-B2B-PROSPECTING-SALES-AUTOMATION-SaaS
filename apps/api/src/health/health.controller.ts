import { timingSafeEqual } from "node:crypto";
import { Controller, Get, Headers, Inject, Res } from "@nestjs/common";
import type { HealthStatus } from "@prospecting/contracts";
import type { Response } from "express";
import { Public } from "../auth/decorators.js";
import { ApiException } from "../http/api-exception.js";
import { renderMetrics } from "../http/metrics.js";
import { HealthService } from "./health.service.js";

const sameSecret = (given: string, expected: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Probes and metrics: intentionally unauthenticated by session and free of tenant data. */
@Public()
@Controller("health")
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get()
  getStatus(): HealthStatus {
    return this.healthService.getStatus();
  }

  /** Readiness: the database answers. The failure reply carries no detail (no connection strings or driver messages). */
  @Get("ready")
  async ready(): Promise<{ status: "ready" }> {
    if (!(await this.healthService.databaseReachable())) throw new ApiException(503, "UNAVAILABLE", "Service not ready");
    return { status: "ready" };
  }

  /**
   * Prometheus metrics. Disabled (404) unless METRICS_TOKEN (>= 32 chars) is configured; otherwise requires `Authorization: Bearer <token>`.
   * Wrong or missing token gets the same 404 so the endpoint's existence is not revealed.
   */
  @Get("metrics")
  metrics(@Headers("authorization") authorization: string | undefined, @Res({ passthrough: true }) res: Response): string {
    const expected = process.env.METRICS_TOKEN ?? "";
    const given = /^Bearer (.+)$/.exec(authorization ?? "")?.[1] ?? "";
    if (expected.length < 32 || !sameSecret(given, expected)) throw new ApiException(404, "NOT_FOUND", "Not found");
    res.type("text/plain; version=0.0.4; charset=utf-8");
    return renderMetrics();
  }
}

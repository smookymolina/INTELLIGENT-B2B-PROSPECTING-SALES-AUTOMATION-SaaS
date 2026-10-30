import { Controller, Get } from "@nestjs/common";
import type { HealthStatus } from "@prospecting/contracts";
import { Public } from "../auth/decorators.js";
import { HealthService } from "./health.service.js";

/** Liveness probe: intentionally unauthenticated and free of tenant data. */
@Public()
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  getStatus(): HealthStatus {
    return this.healthService.getStatus();
  }
}

import { Injectable } from "@nestjs/common";
import type { HealthStatus } from "@prospecting/contracts";

@Injectable()
export class HealthService {
  getStatus(): HealthStatus {
    return { status: "ok", service: "api" };
  }
}

import { describe, expect, it } from "vitest";
import { HealthService } from "./health.service.js";

describe("HealthService", () => {
  it("reports API health", () => {
    expect(new HealthService().getStatus()).toEqual({ status: "ok", service: "api" });
  });
});

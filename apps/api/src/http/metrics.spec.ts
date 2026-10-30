import { describe, expect, it } from "vitest";
import { recordRequest, renderMetrics } from "./metrics.js";

describe("metrics", () => {
  it("renders Prometheus text with bounded labels and escapes hostile ones", () => {
    recordRequest("GET", "/v1/prospects/:id", 200, 0.05);
    recordRequest("GET", "/v1/prospects/:id", 404, 0.01);
    recordRequest("GET", 'x"\ny', 200, 0.01);
    const text = renderMetrics();
    expect(text).toContain('http_requests_total{method="GET",route="/v1/prospects/:id",status="2xx"} 1');
    expect(text).toContain('status="4xx"} 1');
    expect(text).toContain(String.raw`route="x\"\ny"`);
    expect(text).toMatch(/process_uptime_seconds \d+/);
    expect(text.endsWith("\n")).toBe(true);
  });
});

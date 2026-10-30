import type { NextFunction, Response } from "express";
import type { AppRequest } from "../auth/auth.types.js";

/**
 * In-process request metrics in Prometheus text format. Labels are bounded: method, the matched route PATTERN (never the raw URL, so ids and
 * query strings cannot explode cardinality or leak data) and the status class. No tenant, user or token information is ever recorded.
 */
type Series = { count: number; sumSeconds: number };
const series = new Map<string, Series>();
const startedAt = Date.now();

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

export function recordRequest(method: string, route: string, status: number, seconds: number): void {
  const key = `${method}\u0000${route}\u0000${Math.floor(status / 100)}xx`;
  const s = series.get(key) ?? { count: 0, sumSeconds: 0 };
  s.count += 1;
  s.sumSeconds += seconds;
  series.set(key, s);
}

export function metricsMiddleware(req: AppRequest, res: Response, next: NextFunction): void {
  const t0 = process.hrtime.bigint();
  res.on("finish", () => {
    const pattern = typeof req.route?.path === "string" ? `${req.baseUrl}${req.route.path}` : "";
    const route = pattern && !pattern.includes("*") ? pattern : "unmatched"; // wildcard catch-alls are 404s, not real routes
    recordRequest(req.method, route, res.statusCode, Number(process.hrtime.bigint() - t0) / 1e9);
  });
  next();
}

export function renderMetrics(): string {
  const lines = [
    "# HELP http_requests_total HTTP requests by method, route pattern and status class.",
    "# TYPE http_requests_total counter",
  ];
  const rows = [...series.entries()].map(([k, v]) => ({ parts: k.split("\u0000") as [string, string, string], v }));
  for (const { parts: [m, r, c], v } of rows) lines.push(`http_requests_total{method="${esc(m)}",route="${esc(r)}",status="${c}"} ${v.count}`);
  lines.push("# HELP http_request_duration_seconds_sum Total time spent serving requests.", "# TYPE http_request_duration_seconds_sum counter");
  for (const { parts: [m, r, c], v } of rows) lines.push(`http_request_duration_seconds_sum{method="${esc(m)}",route="${esc(r)}",status="${c}"} ${v.sumSeconds.toFixed(6)}`);
  lines.push("# HELP process_uptime_seconds Seconds since the process started.", "# TYPE process_uptime_seconds gauge", `process_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`);
  return `${lines.join("\n")}\n`;
}

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Worker metrics in Prometheus text format. The worker opens no HTTP port, so the text is written atomically to WORKER_METRICS_FILE
 * (node_exporter "textfile collector" pattern) and can also be read in-process. Labels are bounded (job type, outcome, state): no tenant,
 * user or content ever appears.
 */
const outcomes = new Map<string, number>();
const retries = new Map<string, number>();
const durations = new Map<string, { count: number; sum: number }>();
let byState = new Map<string, number>();
const startedAt = Date.now();
let lastTickAt = 0;

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

export type JobOutcome = "succeeded" | "retry" | "dead" | "lost_lease";

export function recordJob(type: string, outcome: JobOutcome, seconds: number): void {
  bump(outcomes, `${type}\u0000${outcome}`);
  if (outcome === "retry") bump(retries, type);
  const d = durations.get(type) ?? { count: 0, sum: 0 };
  d.count += 1;
  d.sum += seconds;
  durations.set(type, d);
}
export function setQueueState(rows: ReadonlyArray<{ state: string; n: number }>): void {
  byState = new Map();
  for (const r of rows) bump(byState, r.state, r.n);
}
export function markTick(at: Date): void {
  lastTickAt = Math.floor(at.getTime() / 1000);
}
export function resetWorkerMetrics(): void {
  outcomes.clear(); retries.clear(); durations.clear(); byState = new Map(); lastTickAt = 0;
}

export function renderWorkerMetrics(): string {
  const l: string[] = [];
  l.push("# HELP worker_jobs_total Jobs finished by type and outcome (succeeded, retry, dead, lost_lease).", "# TYPE worker_jobs_total counter");
  for (const [k, v] of outcomes) {
    const [t, o] = k.split("\u0000") as [string, string];
    l.push(`worker_jobs_total{type="${esc(t)}",outcome="${o}"} ${v}`);
  }
  l.push("# HELP worker_job_retries_total Attempts that failed and were rescheduled with backoff.", "# TYPE worker_job_retries_total counter");
  for (const [t, v] of retries) l.push(`worker_job_retries_total{type="${esc(t)}"} ${v}`);
  l.push("# HELP worker_job_duration_seconds_sum Time spent executing jobs.", "# TYPE worker_job_duration_seconds_sum counter");
  for (const [t, d] of durations) l.push(`worker_job_duration_seconds_sum{type="${esc(t)}"} ${d.sum.toFixed(6)}`, `worker_job_duration_seconds_count{type="${esc(t)}"} ${d.count}`);
  l.push("# HELP worker_queue_jobs Jobs currently in the queue by state (all organizations; counts only). state=\"dead\" is the dead-letter queue depth.", "# TYPE worker_queue_jobs gauge");
  for (const [s, v] of byState) l.push(`worker_queue_jobs{state="${s}"} ${v}`);
  l.push("# HELP worker_last_tick_timestamp_seconds Unix time of the last completed tick.", "# TYPE worker_last_tick_timestamp_seconds gauge", `worker_last_tick_timestamp_seconds ${lastTickAt}`);
  l.push("# HELP worker_uptime_seconds Seconds since the worker started.", "# TYPE worker_uptime_seconds gauge", `worker_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`);
  return `${l.join("\n")}\n`;
}

/** Atomic write (temp file + rename) so a scraper never reads a half-written file. */
export function writeMetricsFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, renderWorkerMetrics());
  renameSync(tmp, path);
}

import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AuditModule } from "../audit/audit.module.js";
import { DbModule } from "../db/db.module.js";
import { HttpSupportModule } from "../http/http.module.js";
import { StructuredLogger } from "../http/structured-logger.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { WorkerService } from "../jobs/worker.service.js";

/** Worker process: reuses the Nest services, opens NO HTTP port, no guards (there is no request); tenant context comes from the job's organization. */
@Module({ imports: [DbModule, HttpSupportModule, AuditModule, JobsModule] })
class WorkerModule {}

const app = await NestFactory.createApplicationContext(WorkerModule, {
  ...(process.env.NODE_ENV === "production" || process.env.LOG_FORMAT === "json" ? { logger: new StructuredLogger() } : {}),
});
app.enableShutdownHooks();
const worker = app.get(WorkerService);

let closing = false;
const shutdown = (signal: string) => {
  if (closing) return;
  closing = true;
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "log", context: "Worker", msg: `event=shutdown signal=${signal}` })}\n`);
  void worker.stop().then(() => app.close()).then(() => process.exit(0), () => process.exit(1));
  setTimeout(() => process.exit(1), 30_000).unref(); // hard stop if a job hangs; its lease expires and another worker reclaims it
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

worker.start();

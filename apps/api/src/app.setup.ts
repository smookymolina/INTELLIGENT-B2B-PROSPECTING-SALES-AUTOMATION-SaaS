import type { INestApplication } from "@nestjs/common";
import { ProblemFilter } from "./http/problem.filter.js";
import { requestId } from "./http/request-id.js";

/** Shared by main.ts and integration tests so both run the same HTTP configuration. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix("v1");
  app.use(requestId);
  app.useGlobalFilters(new ProblemFilter());
  const hops = Number.parseInt(process.env.TRUST_PROXY ?? "0", 10);
  // Only trust X-Forwarded-For behind a known number of proxies; otherwise clients could spoof the IP used for throttling.
  if (hops > 0) (app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void }).set("trust proxy", hops);
  (app.getHttpAdapter().getInstance() as { disable(name: string): void }).disable("x-powered-by");
}

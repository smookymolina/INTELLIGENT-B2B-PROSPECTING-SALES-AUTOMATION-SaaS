import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { configureApp } from "./app.setup.js";
import { StructuredLogger } from "./http/structured-logger.js";

const port = Number.parseInt(process.env.API_PORT ?? "3001", 10);
const app = await NestFactory.create(AppModule, {
  cors: false,
  ...(process.env.NODE_ENV === "production" || process.env.LOG_FORMAT === "json" ? { logger: new StructuredLogger() } : {}),
});
configureApp(app);
app.enableShutdownHooks();
// Loopback by default; containers set API_HOST=0.0.0.0 and expose the port only on the internal network or behind a proxy.
await app.listen(port, process.env.API_HOST ?? "127.0.0.1");

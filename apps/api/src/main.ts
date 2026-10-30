import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { configureApp } from "./app.setup.js";

const port = Number.parseInt(process.env.API_PORT ?? "3001", 10);
const app = await NestFactory.create(AppModule, { cors: false });
configureApp(app);
app.enableShutdownHooks();
await app.listen(port, "127.0.0.1");

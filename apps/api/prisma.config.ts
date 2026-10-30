import { defineConfig } from "prisma/config";

// Migrations run as the owner role; the app connects with DATABASE_URL and drops to `app_runtime` per transaction.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "postgresql://app:app@localhost:5432/prospecting" },
});

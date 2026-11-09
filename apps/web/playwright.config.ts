import { defineConfig } from "@playwright/test";

// Pruebas de navegador contra la pila ya levantada (docker compose --profile app up -d).
// Usa el Chrome del sistema (channel "chrome"): no descarga navegadores.
export default defineConfig({
  testDir: "./browser-tests",
  testMatch: "**/*.browser.ts",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.WEB_URL ?? "http://localhost:3000", channel: "chrome", headless: true, launchOptions: { args: ["--disable-gpu", "--disable-extensions"] } },
});

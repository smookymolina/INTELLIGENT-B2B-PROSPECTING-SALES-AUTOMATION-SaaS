// Generates docs/api/openapi.v1.json from the contracts package. `--check` fails if the committed file is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { buildOpenApi } = await import(pathToFileURL(join(root, "packages/contracts/dist/openapi.js")).href);
const target = join(root, "docs/api/openapi.v1.json");
const next = `${JSON.stringify(buildOpenApi(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(target, "utf8"); } catch { /* missing */ }
  if (current !== next) {
    console.error("docs/api/openapi.v1.json is out of date. Run: npm run openapi:generate");
    process.exit(1);
  }
  console.log("openapi.v1.json is up to date");
} else {
  writeFileSync(target, next);
  console.log("wrote docs/api/openapi.v1.json");
}

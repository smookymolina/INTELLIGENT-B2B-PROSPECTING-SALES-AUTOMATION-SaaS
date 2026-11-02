import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiClient } from "./client.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./tools.js";

const log = (msg: string) => process.stderr.write(`[mcp] ${msg}\n`);

async function main(): Promise<void> {
  const cfg = loadConfig();
  const server = new McpServer({ name: "prospecting-drafts", version: "0.1.0" });
  registerTools(server, new ApiClient(cfg));
  await server.connect(new StdioServerTransport());
  log(`ready (api ${new URL(cfg.apiUrl).origin})`);
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : "unknown error"}`);
  process.exit(1);
});

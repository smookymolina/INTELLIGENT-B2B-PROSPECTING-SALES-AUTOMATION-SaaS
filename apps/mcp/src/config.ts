export const DEFAULT_API_URL = "http://127.0.0.1:3001/v1";
export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 256 * 1024;

export type McpConfig = { apiUrl: string; token: string };

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Reads and validates the environment. Error messages never contain the token. */
export function loadConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const token = env["MCP_API_TOKEN"]?.trim();
  if (!token) throw new Error("MCP_API_TOKEN is required (set it in the server environment, never as an argument)");
  const raw = (env["MCP_API_URL"]?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MCP_API_URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("MCP_API_URL must be http(s)");
  if (url.username || url.password) throw new Error("MCP_API_URL must not contain credentials");
  if (!LOCAL_HOSTS.has(url.hostname) && env["MCP_ALLOW_REMOTE"] !== "1") {
    throw new Error("MCP_API_URL points to a non-local host; set MCP_ALLOW_REMOTE=1 to allow it");
  }
  return { apiUrl: raw, token };
}

import { RATES, type AiCompletion, type AiCompletionRequest, type AiProvider } from "./providers.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2026-10-21";

type MessagesResponse = {
  model?: unknown;
  stop_reason?: unknown;
  content?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown; cache_creation_input_tokens?: unknown; cache_read_input_tokens?: unknown };
};

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * Real adapter for the Anthropic Messages API (AI_PROVIDER=anthropic), over native fetch: no SDK is installed.
 * Configuration is read per call: ANTHROPIC_API_KEY (required), ANTHROPIC_MODEL (optional) and ANTHROPIC_BASE_URL (optional, tests/proxies).
 * Errors never carry the key, the prompt or the response body: only the HTTP status and the vendor's error type.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";

  /** Without a key the provider is left out of the chain, so the API answers a clean 503 and records nothing. */
  available(env: NodeJS.ProcessEnv = process.env): boolean {
    return !!env.ANTHROPIC_API_KEY?.trim();
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletion> {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) throw new Error("Anthropic provider is not configured");
    const model = process.env.ANTHROPIC_MODEL?.trim() || ANTHROPIC_DEFAULT_MODEL;
    // A model without a known rate would be booked at zero cost and slip past the tenant budget: refuse it instead.
    if (!RATES[model]) throw new Error(`Anthropic model has no configured rate: ${model.slice(0, 60)}`);
    const base = (process.env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    let status: number;
    let body: unknown;
    try {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": API_VERSION },
        body: JSON.stringify({
          model,
          max_tokens: request.maxOutputTokens,
          // Thinking cannot be disabled on current models and counts against max_tokens: keep it shallow for this short, schema-bound task.
          output_config: { effort: "low" },
          system: request.system,
          messages: [{ role: "user", content: request.user }],
        }),
        signal: controller.signal,
      });
      status = res.status;
      body = await res.json().catch(() => null);
    } catch {
      // The original error is dropped on purpose: it may quote the request.
      throw new Error(controller.signal.aborted ? `Anthropic request timed out after ${request.timeoutMs} ms` : "Anthropic request failed: network error");
    } finally {
      clearTimeout(timer);
    }

    if (status < 200 || status >= 300) {
      const type = (body as { error?: { type?: unknown } } | null)?.error?.type;
      const safeType = typeof type === "string" && /^[a-z_]{1,40}$/.test(type) ? ` (${type})` : "";
      throw new Error(`Anthropic API error: HTTP ${status}${safeType}`);
    }
    const data = body as MessagesResponse | null;
    if (!data || !Array.isArray(data.content) || !data.usage) throw new Error("Anthropic API returned an unexpected response");
    if (data.stop_reason === "refusal") throw new Error("Anthropic API declined the request");

    const text = (data.content as Array<{ type?: unknown; text?: unknown }>)
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    const u = data.usage;
    return {
      text,
      // The served model is booked only when its rate is known; otherwise the requested (rated) model is.
      model: typeof data.model === "string" && RATES[data.model] ? data.model : model,
      inputTokens: count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens),
      outputTokens: count(u.output_tokens), // includes thinking tokens, which are billed as output
    };
  }
}

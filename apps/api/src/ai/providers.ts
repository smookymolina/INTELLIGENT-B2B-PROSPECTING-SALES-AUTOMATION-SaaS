import { Injectable } from "@nestjs/common";
import { ApiException } from "../http/api-exception.js";
import { AnthropicProvider } from "./anthropic.provider.js";

export type AiCompletionRequest = Readonly<{ system: string; user: string; maxOutputTokens: number; timeoutMs: number }>;
export type AiCompletion = Readonly<{ text: string; model: string; inputTokens: number; outputTokens: number }>;

/** Adapters normalise one vendor behind this shape. No vendor SDK is installed yet: real adapters need a signed-off provider, region and DPA. */
export interface AiProvider {
  readonly name: string;
  /** Optional: a provider that lacks its configuration (e.g. API key) reports false and is left out of the chain. */
  available?(env: NodeJS.ProcessEnv): boolean;
  complete(request: AiCompletionRequest): Promise<AiCompletion>;
}

/** Rates in micro-units (millionths of a USD for real models) per 1 000 tokens. "mock-1" is synthetic, so budgets and ledgers can be exercised offline. */
export const RATES: Readonly<Record<string, { inputPer1k: number; outputPer1k: number }>> = {
  "mock-1": { inputPer1k: 1000, outputPer1k: 3000 },
  // Anthropic first-party list prices. Source: Claude API reference (model table cached 2026-11-03), read 2026-11-11.
  // Review against https://platform.claude.com/docs/en/pricing and the signed contract before production use.
  "claude-opus-5-5": { inputPer1k: 4000, outputPer1k: 20000 }, // USD 4 / 20 per 1M tokens
  "claude-sonnet-5-5": { inputPer1k: 2000, outputPer1k: 10000 }, // USD 2 / 10 per 1M tokens
};
export function costMicros(model: string, inputTokens: number, outputTokens: number): number {
  const r = RATES[model];
  if (!r) return 0; // unknown model: recorded at zero rather than guessed; the run still carries its tokens
  return Math.ceil((inputTokens * r.inputPer1k) / 1000) + Math.ceil((outputTokens * r.outputPer1k) / 1000);
}

const tokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

/**
 * Deterministic offline provider for development and tests (AI_PROVIDER=mock). It only restates the evidence it is given.
 * Markers in the untrusted text trigger failure modes so every guardrail can be tested: [[mock:invalid-json]], [[mock:fenced]],
 * [[mock:extra-field]], [[mock:fake-evidence]], [[mock:low-confidence]], [[mock:price]], [[mock:ask-review]], [[mock:error]].
 */
export class MockProvider implements AiProvider {
  readonly name = "mock";

  async complete(request: AiCompletionRequest): Promise<AiCompletion> {
    const has = (m: string) => request.user.includes(`[[mock:${m}]]`);
    if (has("error")) throw new Error("mock provider failure");
    const refs = [...request.user.matchAll(/"ref":"([^"]+)"/g)].map((m) => m[1] as string);
    const names = [...request.user.matchAll(/"name":"([^"]+)"/g)].map((m) => m[1] as string);
    let text: string;
    if (has("invalid-json")) text = "Claro, aquí está mi recomendación (sin JSON)";
    else {
      const body: Record<string, unknown> = {
        summary: `Se sugiere ofrecer: ${names.join(", ") || "lo indicado en la evidencia"}.${has("price") ? " Precio especial de 9,999.00 MXN." : ""}`,
        evidence_ids: has("fake-evidence") ? ["item:00000000-0000-4000-8000-000000000000:v1"] : refs,
        confidence: has("low-confidence") ? 0.3 : 0.9,
        needs_review: has("ask-review"),
        ...(has("extra-field") ? { discount: "50%" } : {}),
      };
      text = has("fenced") ? `\`\`\`json\n${JSON.stringify(body)}\n\`\`\`` : JSON.stringify(body);
    }
    return { text, model: "mock-1", inputTokens: tokens(request.system) + tokens(request.user), outputTokens: tokens(text) };
  }
}

/** Providers are chosen per call from AI_PROVIDER (and optionally AI_FALLBACK_PROVIDER), so a missing configuration is a clean 503, not a crash. */
@Injectable()
export class AiProviders {
  private readonly known = new Map<string, AiProvider>([["mock", new MockProvider()], ["anthropic", new AnthropicProvider()]]);

  register(provider: AiProvider): void {
    this.known.set(provider.name, provider);
  }

  /** Primary first, then the optional fallback. */
  chain(env: NodeJS.ProcessEnv = process.env): AiProvider[] {
    const names = [env.AI_PROVIDER, env.AI_FALLBACK_PROVIDER].filter((n): n is string => !!n && n !== "none");
    const chain = names.map((n) => this.known.get(n)).filter((p): p is AiProvider => !!p && (p.available?.(env) ?? true));
    if (chain.length === 0) throw new ApiException(503, "UNAVAILABLE", "No AI provider is configured");
    return chain;
  }
}

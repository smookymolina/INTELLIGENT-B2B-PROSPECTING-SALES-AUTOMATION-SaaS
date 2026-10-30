import { Inject, Injectable } from "@nestjs/common";
import {
  AiModelOutput,
  type AiAnalyzeRequest,
  type AiRunDto,
  type AiRunListQuery,
  type AiRunPageDto,
  type AiUsageDto,
  type SetAiBudgetRequest,
} from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { EvidenceService } from "../catalog/evidence.service.js";
import { PrismaService, type Tx } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";
import { PROMPTS } from "./prompts.js";
import { AiProviders, costMicros, type AiCompletion, type AiProvider } from "./providers.js";
import { extractJson, looksLikeInjection, neutraliseDelimiters, redactPii, ungroundedNumbers } from "./safety.js";

const PROVIDER_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_TOKENS = 600;
const LOW_CONFIDENCE = 0.6;

type RunRow = {
  id: string; capability: string; prompt_key: string; prompt_version: number; provider: string; model: string; status: string; input_tokens: number; output_tokens: number;
  cost_micros: bigint; latency_ms: number; evidence_refs: string[]; flags: string[]; needs_review: boolean; confidence: { toNumber(): number } | null; output: unknown; created_at: Date;
};

const toDto = (r: RunRow): AiRunDto => {
  const out = r.output as { summary?: string; evidenceIds?: string[] } | null;
  return {
    id: r.id, capability: r.capability, promptKey: r.prompt_key, promptVersion: r.prompt_version, provider: r.provider, model: r.model, status: r.status as AiRunDto["status"],
    needsReview: r.needs_review, flags: r.flags, confidence: r.confidence?.toNumber() ?? null, evidenceRefs: r.evidence_refs,
    output: out?.summary ? { summary: out.summary, evidenceIds: out.evidenceIds ?? [] } : null,
    inputTokens: r.input_tokens, outputTokens: r.output_tokens, costMicros: Number(r.cost_micros), latencyMs: r.latency_ms, createdAt: r.created_at.toISOString(),
  };
};

/** Start (inclusive) and end (exclusive) of the current UTC month: the budget period. */
export function currentPeriod(now = new Date()): { start: Date; end: Date } {
  return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
}

type Evidence = { ref: string; line: string; facts: string };
const factsOf = (parts: Array<string | null | undefined>) => parts.filter(Boolean).join(" ");

/**
 * Provider-neutral AI gateway. Pipeline: budget (deny by default) -> approved evidence only -> PII minimisation and injection screening ->
 * versioned prompt -> provider chain with timeout/fallback -> strict schema -> groundedness checks -> ledger. The model never acts: the result is
 * a recorded suggestion, and anything doubtful is flagged for a human. Every outcome, including refusals, is recorded in the ledger.
 */
@Injectable()
export class AiService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EvidenceService) private readonly evidence: EvidenceService,
    @Inject(AiProviders) private readonly providers: AiProviders,
  ) {}

  async analyze(auth: AuthContext, input: AiAnalyzeRequest): Promise<AiRunDto> {
    const prompt = PROMPTS[input.capability];
    if (!prompt) throw new ApiException(400, "BAD_REQUEST", "Unknown capability");
    const chain = this.providers.chain(); // 503 when nothing is configured: nothing is recorded because nothing was attempted
    const base = { capability: input.capability, promptKey: prompt.key, promptVersion: prompt.version, evidenceRefs: [...new Set(input.evidenceRefs)] };

    // 1. Budget: deny by default (no budget row = blocked), and stop once the month's spend reached the limit.
    const budget = await this.db.withTenant(auth, async (tx) => ({ limit: await this.limit(tx, auth), spent: await this.spent(tx, auth) }));
    if (budget.limit === null || budget.spent >= budget.limit) {
      await this.record(auth, { ...base, provider: "none", model: "none", status: "budget_exceeded", flags: [budget.limit === null ? "no_budget" : "budget_exhausted"] });
      throw new ApiException(429, "RATE_LIMITED", "The AI budget is not available for this organization", { reason: budget.limit === null ? "no_budget" : "budget_exhausted" });
    }

    // 2. Evidence: only approved, current facts can be shown to a model.
    const resolved = await this.evidence.resolve(auth, { refs: base.evidenceRefs });
    const facts: Evidence[] = [];
    const flags = new Set<string>();
    for (const r of resolved.results) {
      if (r.status !== "current" || !r.evidence) {
        flags.add("stale_or_missing_evidence");
        continue;
      }
      const e = r.evidence;
      if ("sku" in e && "name" in e) {
        const features = e.features.map((f) => `${f.name}: ${f.value}`).join("; ");
        facts.push({ ref: e.ref, line: JSON.stringify({ ref: e.ref, kind: e.kind, sku: e.sku, name: e.name, description: e.description, unit: e.unit, features }), facts: factsOf([e.sku, e.name, e.description, e.unit, features]) });
      } else if ("unitPrice" in e) {
        facts.push({ ref: e.ref, line: JSON.stringify({ ref: e.ref, unitPrice: e.unitPrice, currency: e.currency }), facts: factsOf([e.unitPrice, e.currency]) });
      }
    }
    if (facts.length === 0) {
      await this.record(auth, { ...base, provider: "none", model: "none", status: "blocked", flags: ["no_approved_evidence"] });
      throw new ApiException(409, "CONFLICT", "None of the references is approved, current evidence");
    }

    // 3. Minimise and screen the untrusted text.
    const redacted = redactPii(input.text);
    if (redacted.count > 0) flags.add("pii_redacted");
    if (looksLikeInjection(input.text)) flags.add("possible_injection");
    const untrusted = neutraliseDelimiters(redacted.text);
    const user = prompt.build({ evidence: facts.map((f) => f.line).join("\n"), untrusted });

    // 4. Provider chain with timeout and fallback.
    const started = Date.now();
    let completion: AiCompletion | null = null;
    let used: AiProvider | null = null;
    for (const provider of chain) {
      try {
        completion = await this.withTimeout(provider.complete({ system: prompt.system, user, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: PROVIDER_TIMEOUT_MS }));
        used = provider;
        break;
      } catch {
        flags.add(`provider_failed:${provider.name}`);
      }
    }
    const latencyMs = Date.now() - started;
    if (!completion || !used) {
      await this.record(auth, { ...base, provider: chain[0]?.name ?? "none", model: "none", status: "provider_error", flags: [...flags], latencyMs });
      throw new ApiException(503, "UNAVAILABLE", "The AI provider is not available");
    }
    const usage = { inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, costMicros: costMicros(completion.model, completion.inputTokens, completion.outputTokens) };
    const common = { ...base, provider: used.name, model: completion.model, latencyMs, ...usage };

    // 5. Strict schema.
    let parsed: AiModelOutput;
    try {
      const result = AiModelOutput.safeParse(extractJson(completion.text));
      if (!result.success) throw new Error("schema");
      parsed = result.data;
    } catch {
      await this.record(auth, { ...common, status: "schema_invalid", flags: [...flags, "schema_invalid"] });
      throw new ApiException(503, "UNAVAILABLE", "The AI provider returned an answer that does not follow the required format");
    }

    // 6. Groundedness: cited evidence must be what we supplied, and figures must be traceable.
    const allowed = new Set(facts.map((f) => f.ref));
    const cited = [...new Set(parsed.evidence_ids)].filter((id) => allowed.has(id));
    if (cited.length !== new Set(parsed.evidence_ids).size) flags.add("unknown_evidence_cited");
    if (cited.length === 0) flags.add("no_valid_evidence");
    const invented = ungroundedNumbers(parsed.summary, facts.map((f) => f.facts).join(" "), redacted.text);
    if (invented.length > 0) flags.add("ungrounded_number");
    if (parsed.confidence < LOW_CONFIDENCE) flags.add("low_confidence");
    if (parsed.needs_review) flags.add("model_requested_review");
    const needsReview = [...flags].some((f) => f !== "pii_redacted");

    const row = await this.record(auth, {
      ...common, status: needsReview ? "needs_review" : "ok", flags: [...flags], needsReview, confidence: parsed.confidence,
      output: { summary: parsed.summary, evidenceIds: cited }, evidenceRefs: [...allowed],
    });
    return toDto(row);
  }

  async list(auth: AuthContext, q: AiRunListQuery): Promise<AiRunPageDto> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.aiRun.findMany({
        where: { organization_id: auth.organizationId, ...(q.needsReview ? { needs_review: q.needsReview === "true" } : {}), ...(q.cursor ? { id: { lt: q.cursor } } : {}) },
        orderBy: { id: "desc" },
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      return { items: page.map(toDto), nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
    });
  }

  usage(auth: AuthContext): Promise<AiUsageDto> {
    return this.db.withTenant(auth, (tx) => this.usageTx(tx, auth));
  }

  setBudget(auth: AuthContext, input: SetAiBudgetRequest): Promise<AiUsageDto> {
    return this.db.withTenant(auth, async (tx) => {
      const data = { monthly_limit_micros: BigInt(input.monthlyLimitMicros), updated_by: auth.userId, updated_at: new Date() };
      await tx.aiBudget.upsert({ where: { organization_id: auth.organizationId }, create: { organization_id: auth.organizationId, ...data }, update: data });
      await this.audit.record(tx, auth, { action: "ai.budget_set", resourceType: "ai_budget", metadata: { monthlyLimitMicros: input.monthlyLimitMicros } });
      return this.usageTx(tx, auth);
    });
  }

  /* ---------- internals ---------- */

  private async limit(tx: Tx, auth: AuthContext): Promise<number | null> {
    const b = await tx.aiBudget.findUnique({ where: { organization_id: auth.organizationId }, select: { monthly_limit_micros: true } });
    return b ? Number(b.monthly_limit_micros) : null;
  }

  private async spent(tx: Tx, auth: AuthContext): Promise<number> {
    const { start, end } = currentPeriod();
    const sum = await tx.aiRun.aggregate({ where: { organization_id: auth.organizationId, created_at: { gte: start, lt: end } }, _sum: { cost_micros: true } });
    return Number(sum._sum.cost_micros ?? 0n);
  }

  private async usageTx(tx: Tx, auth: AuthContext): Promise<AiUsageDto> {
    const { start, end } = currentPeriod();
    const where = { organization_id: auth.organizationId, created_at: { gte: start, lt: end } };
    const [limit, groups, review] = await Promise.all([
      this.limit(tx, auth),
      tx.aiRun.groupBy({ by: ["capability"], where, _count: { _all: true }, _sum: { cost_micros: true } }),
      tx.aiRun.count({ where: { ...where, needs_review: true } }),
    ]);
    const spent = groups.reduce((n, g) => n + Number(g._sum.cost_micros ?? 0n), 0);
    return {
      period: { from: start.toISOString(), to: end.toISOString() },
      monthlyLimitMicros: limit, spentMicros: spent, remainingMicros: limit === null ? null : Math.max(0, limit - spent),
      runs: groups.reduce((n, g) => n + g._count._all, 0), needsReview: review,
      byCapability: groups.map((g) => ({ capability: g.capability, runs: g._count._all, costMicros: Number(g._sum.cost_micros ?? 0n) })),
    };
  }

  /** Each outcome is recorded in its own transaction so refusals and failures are kept even though the request then errors out. */
  private record(
    auth: AuthContext,
    r: {
      capability: string; promptKey: string; promptVersion: number; provider: string; model: string; status: RunRow["status"]; flags: string[]; evidenceRefs: string[];
      inputTokens?: number; outputTokens?: number; costMicros?: number; latencyMs?: number; needsReview?: boolean; confidence?: number; output?: { summary: string; evidenceIds: string[] };
    },
  ): Promise<RunRow> {
    return this.db.withTenant(auth, async (tx) => {
      const row = await tx.aiRun.create({
        data: {
          organization_id: auth.organizationId, user_id: auth.userId, capability: r.capability, prompt_key: r.promptKey, prompt_version: r.promptVersion, provider: r.provider, model: r.model,
          status: r.status, input_tokens: r.inputTokens ?? 0, output_tokens: r.outputTokens ?? 0, cost_micros: BigInt(r.costMicros ?? 0), latency_ms: r.latencyMs ?? 0,
          evidence_refs: r.evidenceRefs, flags: r.flags, needs_review: r.needsReview ?? false, confidence: r.confidence ?? null, ...(r.output ? { output: r.output } : {}), request_id: auth.requestId,
        },
      });
      await this.audit.record(tx, auth, { action: "ai.run", resourceType: "ai_run", resourceId: row.id, metadata: { capability: r.capability, status: r.status, costMicros: r.costMicros ?? 0 } });
      return row as unknown as RunRow;
    });
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), PROVIDER_TIMEOUT_MS).unref())]);
  }
}

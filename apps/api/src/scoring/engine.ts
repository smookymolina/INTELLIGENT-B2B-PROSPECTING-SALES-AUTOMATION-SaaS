import type { ScoreBreakdownDto, ScoreRule } from "@prospecting/contracts";

export type ScoreInput = Readonly<{
  prospect: Readonly<{ country: string | null; industry: string | null; city: string | null; region: string | null; status: string; domain: string | null }>;
  attributes: ReadonlyArray<Readonly<{ id: string; key: string; value: string; status: string }>>;
}>;

const norm = (v: string) => v.normalize("NFKC").trim().toLowerCase();

/** Looks up the value a rule reads. Only VERIFIED attributes count; unverified or rejected values are invisible to scoring. */
function read(rule: ScoreRule, input: ScoreInput): { value: string | undefined; evidence: string | null } {
  if (rule.source === "field") {
    const p = input.prospect;
    const raw = rule.name === "has_domain" ? (p.domain ? "true" : "false") : (p as Record<string, string | null>)[rule.name];
    return { value: raw ?? undefined, evidence: `field:${rule.name}` };
  }
  const found = input.attributes.find((a) => a.key === rule.name && a.status === "verified");
  return { value: found?.value, evidence: found ? `attribute:${found.id}` : null };
}

function matches(rule: ScoreRule, value: string | undefined): boolean {
  if (rule.op === "exists") return value !== undefined && value.trim() !== "";
  if (rule.op === "missing") return value === undefined || value.trim() === "";
  if (value === undefined) return false; // unknown never satisfies a comparison (so "neq" is not true for missing data)
  const v = norm(value);
  switch (rule.op) {
    case "eq": return v === norm(String(rule.value));
    case "neq": return v !== norm(String(rule.value));
    case "in": return Array.isArray(rule.value) && rule.value.some((x) => norm(x) === v);
    case "gte": case "lte": {
      const n = Number(value);
      if (!Number.isFinite(n) || typeof rule.value !== "number") return false;
      return rule.op === "gte" ? n >= rule.value : n <= rule.value;
    }
    default: return false;
  }
}

/** Deterministic and explainable: every rule appears in the breakdown with its evidence; the total is the sum of matched points. */
export function evaluate(rules: readonly ScoreRule[], input: ScoreInput): { total: number; breakdown: ScoreBreakdownDto[] } {
  const breakdown = rules.map((rule): ScoreBreakdownDto => {
    const { value, evidence } = read(rule, input);
    const matched = matches(rule, value);
    return { ruleId: rule.id, label: rule.label, matched, points: matched ? rule.points : 0, evidence };
  });
  return { total: breakdown.reduce((sum, b) => sum + b.points, 0), breakdown };
}

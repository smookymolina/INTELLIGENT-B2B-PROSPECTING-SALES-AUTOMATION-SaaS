import type { ScoreRule } from "@prospecting/contracts";

/**
 * Rules are edited one per line:  id; puntos; fuente:nombre; operador; valor; etiqueta
 *   mx; 30; field:country; eq; MX; País objetivo
 *   size; 40; attribute:employees; gte; 50; Empresa mediana o grande
 *   dom; 5; field:has_domain; eq; true; Tiene dominio
 *   ind; 10; field:industry; in; logistica, transporte; Giro afín
 *   city; 5; field:city; exists; ; Tiene ciudad
 * `in` takes a comma-separated list, `gte`/`lte` a number, `exists`/`missing` no value. Validation of the result is done by the API.
 */
export function parseRules(text: string): ScoreRule[] | null {
  const rules: ScoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(";").map((p) => p.trim());
    if (parts.length < 6) return null;
    const [id, points, target, op, value, ...labelParts] = parts as [string, string, string, string, string, ...string[]];
    const [source, name] = target.split(":").map((x) => x.trim());
    const pts = Number(points);
    if ((source !== "field" && source !== "attribute") || !name || !Number.isInteger(pts)) return null;
    const rule: Record<string, unknown> = { id, label: labelParts.join("; ").trim(), source, name, op, points: pts };
    if (op === "in") rule.value = value.split(",").map((v) => v.trim()).filter(Boolean);
    else if (op === "gte" || op === "lte") {
      if (value === "" || !Number.isFinite(Number(value))) return null;
      rule.value = Number(value);
    } else if (op !== "exists" && op !== "missing") rule.value = value;
    rules.push(rule as unknown as ScoreRule);
  }
  return rules;
}

export function rulesToText(rules: readonly ScoreRule[]): string {
  return rules
    .map((r) => {
      const value = Array.isArray(r.value) ? r.value.join(", ") : r.value === undefined ? "" : String(r.value);
      return `${r.id}; ${r.points}; ${r.source}:${r.name}; ${r.op}; ${value}; ${r.label}`;
    })
    .join("\n");
}

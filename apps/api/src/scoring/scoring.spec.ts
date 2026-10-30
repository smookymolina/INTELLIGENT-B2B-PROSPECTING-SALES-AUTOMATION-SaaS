import { describe, expect, it } from "vitest";
import type { ScoreRule } from "@prospecting/contracts";
import { classify, fold } from "./classifier.js";
import { evaluate, type ScoreInput } from "./engine.js";

const rule = (r: Partial<ScoreRule> & Pick<ScoreRule, "op" | "points">): ScoreRule => ({ id: "r", label: "L", source: "field", name: "country", ...r }) as ScoreRule;
const input = (over: Partial<ScoreInput["prospect"]> = {}, attributes: ScoreInput["attributes"] = []): ScoreInput => ({
  prospect: { country: "MX", industry: "Logística", city: null, region: null, status: "qualified", domain: "acme.example", ...over },
  attributes,
});

describe("scoring engine", () => {
  it("sums matched points and explains every rule", () => {
    const rules = [
      rule({ id: "mx", op: "eq", value: "mx", points: 30 }),
      rule({ id: "ind", name: "industry", op: "in", value: ["logistica", "Transporte"], points: 20 }),
      rule({ id: "city", name: "city", op: "exists", points: 10 }),
      rule({ id: "dom", name: "has_domain", op: "eq", value: "true", points: 5 }),
    ];
    const r = evaluate(rules, input());
    expect(r.total).toBe(30 + 5); // "Logística" does not equal "logistica": comparisons are exact apart from case/NFKC
    expect(r.breakdown.map((b) => [b.ruleId, b.matched, b.points])).toEqual([["mx", true, 30], ["ind", false, 0], ["city", false, 0], ["dom", true, 5]]);
    expect(r.breakdown[0]?.evidence).toBe("field:country");
  });

  it("only VERIFIED attributes count and carry their id as evidence", () => {
    const rules = [rule({ id: "size", source: "attribute", name: "employees", op: "gte", value: 50, points: 40 })];
    expect(evaluate(rules, input({}, [{ id: "a1", key: "employees", value: "120", status: "unverified" }])).total).toBe(0);
    expect(evaluate(rules, input({}, [{ id: "a1", key: "employees", value: "120", status: "rejected" }])).total).toBe(0);
    const ok = evaluate(rules, input({}, [{ id: "a1", key: "employees", value: "120", status: "verified" }]));
    expect(ok.total).toBe(40);
    expect(ok.breakdown[0]?.evidence).toBe("attribute:a1");
  });

  it("unknown data never satisfies comparisons, negative points subtract, non-numeric values do not match", () => {
    expect(evaluate([rule({ op: "neq", value: "CO", points: 10 })], input({ country: null })).total).toBe(0);
    expect(evaluate([rule({ op: "missing", points: 7 })], input({ country: null })).total).toBe(7);
    expect(evaluate([rule({ op: "eq", value: "MX", points: -15 })], input()).total).toBe(-15);
    const attr = [{ id: "a", key: "employees", value: "muchos", status: "verified" }];
    expect(evaluate([rule({ source: "attribute", name: "employees", op: "gte", value: 1, points: 9 })], input({}, attr)).total).toBe(0);
  });

  it("is deterministic", () => {
    const rules = [rule({ op: "eq", value: "MX", points: 3 })];
    expect(evaluate(rules, input())).toEqual(evaluate(rules, input()));
  });
});

describe("intent classifier (rules-v1)", () => {
  const cls = (t: string) => classify(t).class;

  it("detects each class in Spanish and English, ignoring case and accents", () => {
    expect(cls("Por favor DÁNME de baja de la lista")).toBe("unsubscribe"); // case and accents are ignored; 'baja de la lista' is listed
    expect(cls("Favor de darme de baja")).toBe("unsubscribe");
    expect(cls("Please unsubscribe me")).toBe("unsubscribe");
    expect(cls("No me interesa, gracias")).toBe("no_interest");
    expect(cls("Estoy fuera de la oficina hasta el lunes")).toBe("auto_reply");
    expect(cls("Queremos comprar 20 unidades")).toBe("purchase");
    expect(cls("¿Me envían una cotización?")).toBe("quote");
    expect(cls("Llámame mañana por favor")).toBe("call");
    expect(cls("Necesito más información del catálogo")).toBe("info");
    expect(cls("Escríbanme el próximo año")).toBe("future");
  });

  it("removal requests always win, even next to buying language", () => {
    const r = classify("Queremos comprar pero no me contacten más: darme de baja");
    expect(r.class).toBe("unsubscribe");
    expect(r.matched.map((m) => m.class)).toEqual(expect.arrayContaining(["unsubscribe", "purchase"]));
  });

  it("ties between positive classes, negations and no matches go to human review (never silently irrelevant)", () => {
    expect(classify("Necesito una cotización y más información")).toMatchObject({ class: "review", ambiguous: true });
    expect(classify("No quiero comprar nada")).toMatchObject({ class: "review" });
    expect(classify("Aún no queremos comprar")).toMatchObject({ class: "review", ambiguous: true });
    expect(classify("Gracias por escribir")).toMatchObject({ class: "review", ambiguous: false, matched: [] });
  });

  it("reports the matched phrases and the version for explainability", () => {
    expect(classify("Quiero una cotizacion")).toEqual({ class: "quote", ambiguous: false, matched: [{ class: "quote", phrase: "cotizacion" }], version: "rules-v1" });
    expect(fold("  Cotización  ÁÉÍ ")).toBe("cotizacion aei");
  });
});

import { describe, expect, it } from "vitest";
import { parseRules, rulesToText } from "./rules";

describe("rule lines", () => {
  const text = [
    "# comentario",
    "mx; 30; field:country; eq; MX; País objetivo",
    "size; 40; attribute:employees; gte; 50; Empresa grande",
    "ind; 10; field:industry; in; logistica, transporte ; Giro afín",
    "city; 5; field:city; exists; ; Tiene ciudad; con punto y coma",
  ].join("\n");

  it("parses every operator shape", () => {
    expect(parseRules(text)).toEqual([
      { id: "mx", label: "País objetivo", source: "field", name: "country", op: "eq", value: "MX", points: 30 },
      { id: "size", label: "Empresa grande", source: "attribute", name: "employees", op: "gte", value: 50, points: 40 },
      { id: "ind", label: "Giro afín", source: "field", name: "industry", op: "in", value: ["logistica", "transporte"], points: 10 },
      { id: "city", label: "Tiene ciudad; con punto y coma", source: "field", name: "city", op: "exists", points: 5 },
    ]);
  });

  it("round-trips and tolerates an empty text", () => {
    const rules = parseRules(text) ?? [];
    expect(parseRules(rulesToText(rules))).toEqual(rules);
    expect(parseRules("")).toEqual([]);
  });

  it("rejects malformed lines instead of guessing", () => {
    for (const bad of ["solo; dos", "a; x; field:country; eq; MX; L", "a; 5; nosource; eq; MX; L", "a; 5; other:x; eq; MX; L", "a; 5; field:country; gte; abc; L", "a; 5.5; field:country; eq; MX; L"]) {
      expect(parseRules(bad)).toBeNull();
    }
  });
});

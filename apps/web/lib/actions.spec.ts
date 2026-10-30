import { describe, expect, it } from "vitest";
import { failureCode, featuresToText, orNull, parseFeatures } from "./actions";

describe("parseFeatures", () => {
  it("parses one 'Name: value' per line and round-trips", () => {
    const f = parseFeatures("Color: Rojo\n  Peso:  2 kg: neto \n\n");
    expect(f).toEqual([{ name: "Color", value: "Rojo" }, { name: "Peso", value: "2 kg: neto" }]);
    expect(parseFeatures(featuresToText(f ?? []))).toEqual(f);
    expect(parseFeatures("")).toEqual([]);
  });

  it("rejects malformed lines and repeated names", () => {
    expect(parseFeatures("sin dos puntos")).toBeNull();
    expect(parseFeatures(": valor")).toBeNull();
    expect(parseFeatures("Color:")).toBeNull();
    expect(parseFeatures("Color: a\ncolor: b")).toBeNull();
  });
});

describe("failureCode", () => {
  it("maps API statuses to a fixed vocabulary", () => {
    const f = (status: number) => failureCode({ ok: false, status, problem: null });
    expect([0, 400, 401, 403, 404, 409, 413, 422, 429, 500, 418].map(f)).toEqual([
      "unavailable", "input", "expired", "forbidden", "notfound", "conflict", "toolarge", "input", "rate", "unavailable", "unexpected",
    ]);
  });
  it("orNull turns empty strings into null", () => {
    expect([orNull(""), orNull("x")]).toEqual([null, "x"]);
  });
});

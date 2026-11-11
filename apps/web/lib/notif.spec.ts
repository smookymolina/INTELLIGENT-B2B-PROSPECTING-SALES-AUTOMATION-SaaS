import { describe, expect, it } from "vitest";
import { barValue, formatMicros, formatPercent, isEmail, parseAddresses, parseCount, usageText } from "./notif";

describe("notif helpers", () => {
  it("validates e-mails", () => {
    expect(isEmail("a@b.co")).toBe(true);
    expect(isEmail("a@b")).toBe(false);
    expect(isEmail("a b@c.com")).toBe(false);
  });
  it("parses addresses: skips blanks, lowercases, rejects bad, duplicate or >5", () => {
    expect(parseAddresses([" A@x.com ", "", "b@x.com"])).toEqual(["a@x.com", "b@x.com"]);
    expect(parseAddresses(["a@x.com", "A@x.com"])).toBeNull();
    expect(parseAddresses(["nope"])).toBeNull();
    expect(parseAddresses(["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com"])).toBeNull();
    expect(parseAddresses([])).toEqual([]);
  });
  it("formats percentages and usage", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(12.34)).toMatch(/^12[.,]3 %$/);
    expect(usageText(5, 0, null)).toContain("sin límite");
    expect(usageText(50, 100, 50)).toMatch(/^50 de 100 · 50 %$/);
  });
  it("formats money and bar width", () => {
    expect(formatMicros(1_500_000)).toMatch(/^US\$ 1[.,]50$/);
    expect(barValue(150)).toBe(100);
    expect(barValue(-3)).toBe(0);
    expect(barValue(null)).toBe(0);
  });
  it("parses counts", () => {
    expect(parseCount("0", 10)).toBe(0);
    expect(parseCount("11", 10)).toBeNull();
    expect(parseCount("-1", 10)).toBeNull();
    expect(parseCount("1.5", 10)).toBeNull();
  });
});

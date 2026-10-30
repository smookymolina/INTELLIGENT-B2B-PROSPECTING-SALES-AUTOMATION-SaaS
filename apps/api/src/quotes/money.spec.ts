import { describe, expect, it } from "vitest";
import { discountAmount, fmt4, gross, roundDiv, taxAmount, toScaled, totals } from "./money.js";

describe("exact money arithmetic", () => {
  it("parses and formats fixed point without floating point", () => {
    expect(toScaled("12.5")).toBe(125000n);
    expect(toScaled("0.0001")).toBe(1n);
    expect(toScaled("99999999999999.9999")).toBe(999999999999999999n);
    expect(toScaled("12.5", 2)).toBe(1250n);
    expect(fmt4(125000n)).toBe("12.5000");
    expect(fmt4(1n)).toBe("0.0001");
    expect(fmt4(0n)).toBe("0.0000");
  });

  it("rounds half up like PostgreSQL round(numeric, 4)", () => {
    expect(roundDiv(5n, 10n)).toBe(1n);
    expect(roundDiv(4n, 10n)).toBe(0n);
    // 3 units x 0.3333 = 0.9999 ; 0.0001 x 0.5 = 0.00005 -> 0.0001
    expect(fmt4(gross(toScaled("3"), toScaled("0.3333")))).toBe("0.9999");
    expect(fmt4(gross(toScaled("0.5"), toScaled("0.0001")))).toBe("0.0001");
    // a classic float trap: 0.1 + 0.2 style sums stay exact
    const lines = [{ gross: toScaled("0.1"), discountAmount: 0n }, { gross: toScaled("0.2"), discountAmount: 0n }];
    expect(fmt4(totals(lines, null).total)).toBe("0.3000");
  });

  it("computes discounts and tax on the discounted base", () => {
    const g = gross(toScaled("10"), toScaled("120.50")); // 1205.0000
    const d = discountAmount(g, toScaled("12.5", 2)); // 12.5% = 150.6250
    expect(fmt4(g)).toBe("1205.0000");
    expect(fmt4(d)).toBe("150.6250");
    const t = totals([{ gross: g, discountAmount: d }], toScaled("16")); // 16% of 1054.3750 = 168.7000
    expect(fmt4(t.subtotal)).toBe("1205.0000");
    expect(fmt4(t.discountTotal)).toBe("150.6250");
    expect(fmt4(t.taxTotal)).toBe("168.7000");
    expect(fmt4(t.total)).toBe("1223.0750");
    expect(fmt4(taxAmount(toScaled("0.0003"), toScaled("50")))).toBe("0.0002"); // 0.00015 -> half up
  });
});

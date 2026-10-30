import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv.js";

describe("csv", () => {
  it("quotes only when needed and doubles quotes", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(12)).toBe("12");
    expect(csvCell(false)).toBe("false");
  });

  it("neutralises spreadsheet formulas in text cells but not in numbers", () => {
    for (const evil of ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"]) {
      expect(csvCell(evil).replace(/^"/, "").startsWith("'")).toBe(true);
    }
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell("fine = value")).toBe("fine = value");
  });

  it("joins with CRLF and ends with a final CRLF", () => {
    expect(toCsv(["a", "b"], [["1", "x,y"], [2, null]])).toBe('a,b\r\n1,"x,y"\r\n2,\r\n');
  });
});

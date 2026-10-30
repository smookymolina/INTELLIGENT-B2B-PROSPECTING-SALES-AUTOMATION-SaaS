import { describe, expect, it } from "vitest";
import { CsvError, parseCsv } from "./csv.js";

const limits = { maxRows: 5, maxColumns: 4, maxFieldLength: 20 };
const parse = (s: string) => parseCsv(s, limits);
const code = (s: string) => {
  try {
    parse(s);
    return "no error";
  } catch (e) {
    return e instanceof CsvError ? e.code : "other";
  }
};

describe("parseCsv", () => {
  it("parses plain, quoted, escaped and multi-line fields", () => {
    expect(parse('a,b,c\n1,"x,y","he said ""hi"""\n2,"line1\nline2",\n')).toEqual([
      ["a", "b", "c"],
      ["1", "x,y", 'he said "hi"'],
      ["2", "line1\nline2", ""],
    ]);
  });

  it("accepts LF, CRLF and CR, a BOM, blank lines and a missing final newline", () => {
    const expected = [["a", "b"], ["1", "2"]];
    expect(parse("a,b\n1,2")).toEqual(expected);
    expect(parse("a,b\r\n1,2\r\n")).toEqual(expected);
    expect(parse("a,b\r1,2\r")).toEqual(expected);
    expect(parse("﻿a,b\n\n1,2\n\n")).toEqual(expected);
  });

  it("keeps empty quoted and empty unquoted fields", () => {
    expect(parse('a,"",c\n,,\n')).toEqual([["a", "", "c"], ["", "", ""]]);
  });

  it("rejects malformed input with a precise code", () => {
    expect(code("")).toBe("empty");
    expect(code('a,"unterminated\n')).toBe("unterminated_quote");
    expect(code('a,b"c\n')).toBe("stray_quote");
    expect(code('a,"b"c\n')).toBe("stray_quote");
    expect(code('a,"b" \n')).toBe("stray_quote");
    expect(code("a,b\u0000\n")).toBe("control_character");
  });

  it("enforces row, column and field limits", () => {
    expect(code("a\n1\n2\n3\n4\n5\n")).toBe("no error"); // header + 5 rows
    expect(code("a\n1\n2\n3\n4\n5\n6\n")).toBe("too_many_rows");
    expect(code("a,b,c,d\n")).toBe("no error");
    expect(code("a,b,c,d,e\n")).toBe("too_many_columns");
    expect(code(`a\n${"x".repeat(21)}\n`)).toBe("field_too_long");
  });

  it("does not execute or alter spreadsheet-formula-looking values (they stay plain text)", () => {
    expect(parse("a\n=1+1\n+cmd\n@SUM(A1)\n")).toEqual([["a"], ["=1+1"], ["+cmd"], ["@SUM(A1)"]]);
  });
});

/**
 * CSV for exports (RFC 4180: comma, CRLF, quotes doubled). Cells that a spreadsheet would execute as a formula (= + - @ or a leading tab/CR)
 * are neutralised with a leading apostrophe, so hostile prospect names cannot become formulas when an analyst opens the file.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (typeof value === "string" && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>): string {
  return `${[headers.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n")}\r\n`;
}

/** Hard cap so one request cannot read an unbounded table; callers report truncation in a header. */
export const EXPORT_MAX_ROWS = 10_000;

/** Download headers: attachment, no caching, no sniffing; `X-Export-Truncated` tells the client the cap was hit. */
export function sendCsv(res: { setHeader(name: string, value: string): unknown }, filename: string, truncated: boolean): void {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Export-Truncated", truncated ? "true" : "false");
}

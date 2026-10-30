/**
 * Exact fixed-point arithmetic (BigInt, 4 decimals) that mirrors PostgreSQL `round(numeric, 4)` (half away from zero; all values here are >= 0).
 * The database re-computes and compares everything when a quote is sent, so any divergence is caught, not stored.
 */
const SCALE = 10_000n;

/** "12.5" -> 125000n (scale 4). Callers have validated the shape with the contract regexes. */
export function toScaled(decimal: string, decimals = 4): bigint {
  const [whole = "0", frac = ""] = decimal.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0").slice(0, decimals));
}

/** 125000n -> "12.5000" */
export function fmt4(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? "-" : ""}${abs / SCALE}.${(abs % SCALE).toString().padStart(4, "0")}`;
}

/** 1250n -> "12.50" (scale 2, percentages) */
export function fmt2(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

/** Division rounded half up (operands are non-negative). */
export const roundDiv = (numerator: bigint, denominator: bigint): bigint => (numerator + denominator / 2n) / denominator;

/** quantity (scale 4) x unit price (scale 4) -> scale 4 */
export const gross = (quantity4: bigint, price4: bigint): bigint => roundDiv(quantity4 * price4, SCALE);
/** gross (scale 4) x percentage (scale 2, e.g. 12.5% = 1250n) -> scale 4 */
export const discountAmount = (gross4: bigint, percent2: bigint): bigint => roundDiv(gross4 * percent2, 10_000n);
/** taxable base (scale 4) x rate (percentage, scale 4) -> scale 4 */
export const taxAmount = (base4: bigint, rate4: bigint): bigint => roundDiv(base4 * rate4, 1_000_000n);

export type Line = { gross: bigint; discountAmount: bigint };
export function totals(lines: readonly Line[], taxRate4: bigint | null): { subtotal: bigint; discountTotal: bigint; taxTotal: bigint; total: bigint } {
  const subtotal = lines.reduce((s, l) => s + l.gross, 0n);
  const discountTotal = lines.reduce((s, l) => s + l.discountAmount, 0n);
  const taxTotal = taxRate4 === null ? 0n : taxAmount(subtotal - discountTotal, taxRate4);
  return { subtotal, discountTotal, taxTotal, total: subtotal - discountTotal + taxTotal };
}

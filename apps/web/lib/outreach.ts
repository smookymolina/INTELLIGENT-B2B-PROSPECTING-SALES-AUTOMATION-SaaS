import type { ApiResult } from "./api";
import { failureCode } from "./actions";

type Failure = Extract<ApiResult<unknown>, { ok: false }>;

/** Merge errors get their own short, clear messages (the API text itself is never shown). */
export function mergeFailureCode(result: Failure): string {
  if (result.status === 409) {
    const m = (result.problem?.message ?? "").toLowerCase();
    if (m.includes("chain")) return "mergechain";
    if (m.includes("already merged")) return "mergeduplicate";
    if (m.includes("already reverted")) return "mergereverted";
  }
  if (result.status === 400 && (result.problem?.message ?? "").toLowerCase().includes("itself")) return "mergeself";
  return failureCode(result);
}

/** Draft errors: a 409/422 means "not eligible / not pending" rather than a generic conflict. */
export function draftFailureCode(result: Failure): string {
  return result.status === 409 || result.status === 422 ? "draftineligible" : failureCode(result);
}

/** Evidence refs are opaque ids from the outreach context; only plausible tokens are forwarded (the API revalidates them). */
export function cleanRefs(values: FormDataEntryValue[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 100 && !/[\s\u0000]/.test(v)))].slice(0, 20);
}

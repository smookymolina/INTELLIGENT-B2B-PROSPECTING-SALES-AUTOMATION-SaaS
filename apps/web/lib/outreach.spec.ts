import { describe, expect, it } from "vitest";
import { cleanRefs, draftFailureCode, mergeFailureCode } from "./outreach";

const fail = (status: number, message?: string) => ({ ok: false as const, status, problem: message ? { code: "CONFLICT", message, details: null, request_id: "00000000-0000-4000-8000-000000000000" } : null });

describe("mergeFailureCode", () => {
  it("names chains, double merges and repeated reverts", () => {
    expect(mergeFailureCode(fail(409, "Merge chains are not allowed: unmerge first"))).toBe("mergechain");
    expect(mergeFailureCode(fail(409, "This prospect is already merged into another one"))).toBe("mergeduplicate");
    expect(mergeFailureCode(fail(409, "The merge was already reverted"))).toBe("mergereverted");
    expect(mergeFailureCode(fail(400, "A prospect cannot be merged into itself"))).toBe("mergeself");
  });
  it("falls back to the generic vocabulary", () => {
    expect(mergeFailureCode(fail(409))).toBe("conflict");
    expect(mergeFailureCode(fail(403))).toBe("forbidden");
    expect(mergeFailureCode(fail(0))).toBe("unavailable");
  });
});

describe("draftFailureCode", () => {
  it("maps ineligible or decided drafts and keeps the rest generic", () => {
    expect(draftFailureCode(fail(409))).toBe("draftineligible");
    expect(draftFailureCode(fail(403))).toBe("forbidden");
  });
});

describe("cleanRefs", () => {
  it("keeps unique plausible refs and drops junk", () => {
    expect(cleanRefs(["a:1", "a:1", "", "has space", "b:2", new File([], "f")])).toEqual(["a:1", "b:2"]);
  });
});

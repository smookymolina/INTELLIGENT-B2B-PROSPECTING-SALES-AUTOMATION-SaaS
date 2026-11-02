import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiException } from "../http/api-exception.js";
import { hasNulChar, ZodPipe } from "./zod.pipe.js";

describe("ZodPipe NUL handling", () => {
  it("detects U+0000 in nested values and keys", () => {
    expect(hasNulChar({ a: ["x", { b: "y\u0000" }] })).toBe(true);
    expect(hasNulChar({ "k\u0000": 1 })).toBe(true);
    expect(hasNulChar({ a: ["x", { b: "ok" }], n: 3, z: null })).toBe(false);
  });
  it("rejects with a 400 validation error instead of reaching the database", () => {
    const pipe = new ZodPipe(z.object({ name: z.string() }));
    expect(() => pipe.transform({ name: "a\u0000b" })).toThrow(ApiException);
    expect(pipe.transform({ name: "ok" })).toEqual({ name: "ok" });
  });
});

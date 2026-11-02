import type { PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";
import { ApiException } from "../http/api-exception.js";

/** PostgreSQL cannot store U+0000 (it would surface as a 500), so it is rejected as invalid input everywhere. */
/** Path of the first string (or key) containing U+0000, or null. Dot-joined like zod issue paths. */
export function nulPath(value: unknown, path = "", depth = 0): string | null {
  const nul = "\u0000";
  if (typeof value === "string") return value.includes(nul) ? path : null;
  if (depth > 20 || value === null || typeof value !== "object") return null;
  for (const [k, v] of Object.entries(value)) {
    const here = path ? `${path}.${k}` : k;
    if (k.includes(nul)) return here;
    const found = nulPath(v, here, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

export const hasNulChar = (value: unknown): boolean => nulPath(value) !== null;

/** Validates and strips input with a shared strict schema; error output never echoes submitted values. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const nul = nulPath(value);
    if (nul !== null) throw new ApiException(400, "VALIDATION_FAILED", "Validation failed", { issues: [{ path: nul, code: "control_character" }] });
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ApiException(400, "VALIDATION_FAILED", "Validation failed", { issues: result.error.issues.map((i) => ({ path: i.path.join("."), code: i.code })) });
    }
    return result.data;
  }
}

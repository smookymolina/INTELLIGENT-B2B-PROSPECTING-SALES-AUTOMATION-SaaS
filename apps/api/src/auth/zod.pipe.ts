import type { PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";
import { ApiException } from "../http/api-exception.js";

/** Validates and strips input with a shared strict schema; error output never echoes submitted values. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ApiException(400, "VALIDATION_FAILED", "Validation failed", { issues: result.error.issues.map((i) => ({ path: i.path.join("."), code: i.code })) });
    }
    return result.data;
  }
}

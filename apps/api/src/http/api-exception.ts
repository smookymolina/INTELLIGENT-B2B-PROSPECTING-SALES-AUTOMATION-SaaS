import { HttpException } from "@nestjs/common";
import type { ErrorCode } from "@prospecting/contracts";

/** Error with a stable machine-readable code; rendered by ProblemFilter into the `{code,message,details,request_id}` envelope. */
export class ApiException extends HttpException {
  constructor(
    status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: unknown = null,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message, status);
  }
}

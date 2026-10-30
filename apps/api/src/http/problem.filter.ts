import { randomUUID } from "node:crypto";
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { ErrorCode } from "@prospecting/contracts";
import type { Response } from "express";
import type { AppRequest } from "../auth/auth.types.js";
import { ApiException } from "./api-exception.js";

const CODE_BY_STATUS: Record<number, ErrorCode> = { 400: "VALIDATION_FAILED", 401: "UNAUTHENTICATED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 429: "RATE_LIMITED" };

/** Renders every error as `{code,message,details,request_id}`. Unexpected errors never leak internals; they are logged server-side by name/code only. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger("Http");

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const requestId = http.getRequest<AppRequest>().requestId ?? randomUUID();

    let status = 500;
    let code: ErrorCode = "INTERNAL_ERROR";
    let message = "Internal server error";
    let details: unknown = null;

    if (exception instanceof ApiException) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
      for (const [name, value] of Object.entries(exception.headers)) res.setHeader(name, value);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = CODE_BY_STATUS[status] ?? "BAD_REQUEST";
      message = exception.message;
    } else if (isClientError(exception)) {
      // body-parser / http-errors (malformed JSON, payload too large, ...)
      status = exception.status;
      code = "BAD_REQUEST";
      message = "Malformed request";
    } else {
      const e = exception as { name?: string; code?: string };
      this.logger.error(`request_id=${requestId} unexpected ${e?.name ?? "error"}${e?.code ? ` code=${e.code}` : ""}`);
    }

    res.status(status).json({ code, message, details, request_id: requestId });
  }
}

function isClientError(e: unknown): e is { status: number } {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

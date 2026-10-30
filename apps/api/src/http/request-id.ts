import { randomUUID } from "node:crypto";
import type { NextFunction, Response } from "express";
import type { AppRequest } from "../auth/auth.types.js";

/** Server-generated id for every request (including 404s and parse errors); client-supplied ids are ignored so audit correlation cannot be forged. */
export function requestId(req: AppRequest, res: Response, next: NextFunction): void {
  req.requestId = randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
}

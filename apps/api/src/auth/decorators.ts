import { createParamDecorator, SetMetadata, type ExecutionContext } from "@nestjs/common";
import type { Permission } from "@prospecting/contracts";
import type { AppRequest, AuthContext } from "./auth.types.js";

export const IS_PUBLIC = "isPublic";
export const REQUIRED_PERMISSION = "requiredPermission";

export const Public = () => SetMetadata(IS_PUBLIC, true);
export const RequirePermission = (permission: Permission) => SetMetadata(REQUIRED_PERMISSION, permission);

export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = ctx.switchToHttp().getRequest<AppRequest>().auth;
  if (!auth) throw new Error("Auth decorator used on a route without an authenticated session");
  return auth;
});

/** Peer address as resolved by Express; only honours X-Forwarded-For when TRUST_PROXY is configured. */
export const ClientIp = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest<AppRequest>().ip ?? "unknown";
});

export const RequestId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest<AppRequest>().requestId ?? "unknown";
});

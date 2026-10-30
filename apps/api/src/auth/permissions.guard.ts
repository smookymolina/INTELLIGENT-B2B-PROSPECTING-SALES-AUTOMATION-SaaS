import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { hasPermission, type Permission } from "@prospecting/contracts";
import type { AppRequest } from "./auth.types.js";
import { REQUIRED_PERMISSION } from "./decorators.js";

/** RBAC: routes declare a permission; the role comes from the verified membership. Routes without one only need a session. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission | undefined>(REQUIRED_PERMISSION, [context.getHandler(), context.getClass()]);
    if (!required) return true;
    const auth = context.switchToHttp().getRequest<AppRequest>().auth;
    if (!auth || !hasPermission(auth.role, required)) throw new ForbiddenException();
    return true;
  }
}

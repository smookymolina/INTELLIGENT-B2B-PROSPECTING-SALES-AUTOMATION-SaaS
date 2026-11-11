import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { AppRequest } from "../auth/auth.types.js";
import { PlatformAdminService } from "./platform-admin.service.js";

/** Exige pertenencia a platform_admins (tabla que ningun endpoint puede escribir). Corre despues del AuthGuard global. */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(@Inject(PlatformAdminService) private readonly svc: PlatformAdminService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const auth = context.switchToHttp().getRequest<AppRequest>().auth;
    if (!auth || !(await this.svc.isPlatformAdmin(auth))) throw new ForbiddenException();
    return true;
  }
}

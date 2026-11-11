import { Controller, Get, Inject, Param, Query, UseGuards } from "@nestjs/common";
import { PlatformAdminPageQuery, PlatformAdminResourceParam, UuidParam, type PlatformAdminResource, type PlatformAdminOrganizationsDto, type PlatformAdminResourceDto } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { PlatformAdminGuard } from "./platform-admin.guard.js";
import { PlatformAdminService } from "./platform-admin.service.js";

/** Solo GET: cualquier otro metodo no existe (404). El rol no se asigna por API; ver docs/security/SAAS_ADMIN_DECISION.md. */
@Controller("platform-admin")
@UseGuards(PlatformAdminGuard)
export class PlatformAdminController {
  constructor(@Inject(PlatformAdminService) private readonly svc: PlatformAdminService) {}

  @Get("organizations")
  organizations(@Auth() auth: AuthContext, @Query(new ZodPipe(PlatformAdminPageQuery)) q: PlatformAdminPageQuery): Promise<PlatformAdminOrganizationsDto> {
    return this.svc.organizations(auth, q);
  }

  @Get("organizations/:id/:resource")
  resource(
    @Auth() auth: AuthContext,
    @Param("id", new ZodPipe(UuidParam)) id: string,
    @Param("resource", new ZodPipe(PlatformAdminResourceParam)) resource: PlatformAdminResource,
    @Query(new ZodPipe(PlatformAdminPageQuery)) q: PlatformAdminPageQuery,
  ): Promise<PlatformAdminResourceDto> {
    return this.svc.resource(auth, id, resource, q);
  }
}

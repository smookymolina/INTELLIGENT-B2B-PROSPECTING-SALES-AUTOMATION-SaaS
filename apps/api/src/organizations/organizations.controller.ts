import { Body, Controller, Get, Inject, Patch } from "@nestjs/common";
import { UpdateOrganizationRequest, type OrganizationDto } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { OrganizationsService } from "./organizations.service.js";

/** Singleton resource: the organization is always the caller's own, derived from the session (no id in the URL or body). */
@Controller("organization")
export class OrganizationsController {
  constructor(@Inject(OrganizationsService) private readonly orgs: OrganizationsService) {}

  @Get()
  @RequirePermission("organization:read")
  get(@Auth() auth: AuthContext): Promise<OrganizationDto> {
    return this.orgs.get(auth);
  }

  @Patch()
  @RequirePermission("organization:update")
  update(@Auth() auth: AuthContext, @Body(new ZodPipe(UpdateOrganizationRequest)) body: UpdateOrganizationRequest): Promise<OrganizationDto> {
    return this.orgs.update(auth, body);
  }
}

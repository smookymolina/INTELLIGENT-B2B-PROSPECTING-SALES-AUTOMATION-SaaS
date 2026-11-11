import { Body, Controller, Get, Inject, Put } from "@nestjs/common";
import { SetLeadQuotaRequest, type CohortListDto, type LeadQuotaDto } from "@prospecting/contracts";
import type { AuthContext } from "../../auth/auth.types.js";
import { Auth, RequirePermission } from "../../auth/decorators.js";
import { ZodPipe } from "../../auth/zod.pipe.js";
import { LifecycleService } from "./lifecycle.service.js";

/** Fixed routes: must be registered before `ProspectsController` (`/prospects/:id`). */
@Controller("prospects")
export class LifecycleController {
  constructor(@Inject(LifecycleService) private readonly lifecycle: LifecycleService) {}

  @Get("cohorts")
  @RequirePermission("prospects:read")
  cohorts(@Auth() auth: AuthContext): Promise<CohortListDto> {
    return this.lifecycle.cohorts(auth);
  }

  @Get("lead-quota")
  @RequirePermission("prospects:read")
  quota(@Auth() auth: AuthContext): Promise<LeadQuotaDto> {
    return this.lifecycle.getQuota(auth);
  }

  /** org_admin only: the permission gates the route and the RLS policy re-checks the role in the database. */
  @Put("lead-quota")
  @RequirePermission("organization:update")
  setQuota(@Auth() auth: AuthContext, @Body(new ZodPipe(SetLeadQuotaRequest)) body: SetLeadQuotaRequest): Promise<LeadQuotaDto> {
    return this.lifecycle.setQuota(auth, body);
  }
}

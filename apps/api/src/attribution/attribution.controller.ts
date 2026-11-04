import { Controller, Get, Inject, Query } from "@nestjs/common";
import { AttributionQuery, CohortsQuery, type AttributionReportDto, type CohortsReportDto } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { AttributionService } from "./attribution.service.js";

@Controller("attribution")
export class AttributionController {
  constructor(@Inject(AttributionService) private readonly attribution: AttributionService) {}

  @Get("campaigns")
  @RequirePermission("analytics:read")
  campaigns(@Auth() auth: AuthContext, @Query(new ZodPipe(AttributionQuery)) q: AttributionQuery): Promise<AttributionReportDto> {
    return this.attribution.campaigns(auth, q);
  }

  @Get("cohorts")
  @RequirePermission("analytics:read")
  cohorts(@Auth() auth: AuthContext, @Query(new ZodPipe(CohortsQuery)) q: CohortsQuery): Promise<CohortsReportDto> {
    return this.attribution.cohorts(auth, q);
  }
}

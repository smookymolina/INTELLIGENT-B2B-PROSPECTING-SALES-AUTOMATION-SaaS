import { Controller, Get, Inject, Query } from "@nestjs/common";
import { AnalyticsEventsQuery, AnalyticsQuery, type AnalyticsEventPageDto, type AnalyticsOverviewDto } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { AnalyticsService } from "./analytics.service.js";

@Controller("analytics")
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analytics: AnalyticsService) {}

  @Get("overview")
  @RequirePermission("analytics:read")
  overview(@Auth() auth: AuthContext, @Query(new ZodPipe(AnalyticsQuery)) q: AnalyticsQuery): Promise<AnalyticsOverviewDto> {
    return this.analytics.overview(auth, q);
  }

  @Get("events")
  @RequirePermission("analytics:read")
  events(@Auth() auth: AuthContext, @Query(new ZodPipe(AnalyticsEventsQuery)) q: AnalyticsEventsQuery): Promise<AnalyticsEventPageDto> {
    return this.analytics.events(auth, q);
  }
}

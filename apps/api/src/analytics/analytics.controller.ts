import { Controller, Get, Inject, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { AnalyticsEventsQuery, AnalyticsExportQuery, AnalyticsQuery, type AnalyticsEventPageDto, type AnalyticsOverviewDto } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { sendCsv } from "../http/csv.js";
import { AnalyticsService } from "./analytics.service.js";

@Controller("analytics")
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analytics: AnalyticsService) {}

  @Get("overview")
  @RequirePermission("analytics:read")
  overview(@Auth() auth: AuthContext, @Query(new ZodPipe(AnalyticsQuery)) q: AnalyticsQuery): Promise<AnalyticsOverviewDto> {
    return this.analytics.overview(auth, q);
  }

  @Get("events/export")
  @RequirePermission("analytics:read")
  async exportEvents(@Auth() auth: AuthContext, @Query(new ZodPipe(AnalyticsExportQuery)) q: AnalyticsExportQuery, @Res({ passthrough: true }) res: Response): Promise<string> {
    const { csv, truncated } = await this.analytics.exportEvents(auth, q);
    sendCsv(res, `analytics-${q.metric}.csv`, truncated);
    return csv;
  }

  @Get("events")
  @RequirePermission("analytics:read")
  events(@Auth() auth: AuthContext, @Query(new ZodPipe(AnalyticsEventsQuery)) q: AnalyticsEventsQuery): Promise<AnalyticsEventPageDto> {
    return this.analytics.events(auth, q);
  }
}

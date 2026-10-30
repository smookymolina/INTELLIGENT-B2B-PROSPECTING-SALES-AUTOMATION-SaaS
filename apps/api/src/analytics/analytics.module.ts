import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { AnalyticsController } from "./analytics.controller.js";
import { AnalyticsService } from "./analytics.service.js";

@Module({ imports: [AuditModule], controllers: [AnalyticsController], providers: [AnalyticsService] })
export class AnalyticsModule {}

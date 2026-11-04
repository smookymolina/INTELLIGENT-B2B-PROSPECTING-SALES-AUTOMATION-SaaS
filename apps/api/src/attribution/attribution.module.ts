import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { AttributionController } from "./attribution.controller.js";
import { AttributionService } from "./attribution.service.js";

@Module({ imports: [AuditModule], controllers: [AttributionController], providers: [AttributionService] })
export class AttributionModule {}

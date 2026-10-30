import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { OpportunitiesController, RoutingController } from "./crm.controller.js";
import { CrmService } from "./crm.service.js";

@Module({ imports: [AuditModule], controllers: [OpportunitiesController, RoutingController], providers: [CrmService], exports: [CrmService] })
export class CrmModule {}

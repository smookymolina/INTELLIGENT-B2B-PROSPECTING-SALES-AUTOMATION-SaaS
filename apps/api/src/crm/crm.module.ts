import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { OpportunitiesController, RoutingController } from "./crm.controller.js";
import { CrmService } from "./crm.service.js";
import { TasksController } from "./tasks.controller.js";
import { TasksService } from "./tasks.service.js";

@Module({ imports: [AuditModule], controllers: [OpportunitiesController, RoutingController, TasksController], providers: [CrmService, TasksService], exports: [CrmService] })
export class CrmModule {}

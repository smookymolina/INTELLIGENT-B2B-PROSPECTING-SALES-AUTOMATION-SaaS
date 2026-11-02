import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { ProspectImportController } from "./prospect-import.controller.js";
import { ProspectImportService } from "./prospect-import.service.js";
import { ProspectMergeController } from "./prospect-merge.controller.js";
import { ProspectMergeService } from "./prospect-merge.service.js";
import { ProspectsController, SuppressionsController } from "./prospects.controller.js";
import { ProspectsService } from "./prospects.service.js";

// Controller order matters: fixed `/prospects/imports` routes must be registered before `/prospects/:id`.
@Module({
  imports: [AuditModule],
  controllers: [ProspectImportController, ProspectMergeController, ProspectsController, SuppressionsController],
  providers: [ProspectsService, ProspectImportService, ProspectMergeService],
  exports: [ProspectsService],
})
export class ProspectsModule {}

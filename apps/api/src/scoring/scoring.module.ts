import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { ProspectsModule } from "../prospects/prospects.module.js";
import { LeadsService } from "./leads.service.js";
import { LeadsController, ProspectInsightsController, ScoringController } from "./scoring.controller.js";
import { ScoringService } from "./scoring.service.js";

@Module({
  imports: [AuditModule, ProspectsModule],
  controllers: [ProspectInsightsController, ScoringController, LeadsController],
  providers: [ScoringService, LeadsService],
  exports: [ScoringService, LeadsService],
})
export class ScoringModule {}

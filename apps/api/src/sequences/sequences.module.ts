import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { CampaignsModule } from "../campaigns/campaigns.module.js";
import { ProspectsModule } from "../prospects/prospects.module.js";
import { SequencesController } from "./sequences.controller.js";
import { SequencesService } from "./sequences.service.js";

@Module({
  imports: [AuditModule, ProspectsModule, CampaignsModule],
  controllers: [SequencesController],
  providers: [SequencesService],
  exports: [SequencesService],
})
export class SequencesModule {}

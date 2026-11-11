import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { CampaignsModule } from "../campaigns/campaigns.module.js";
import { CatalogModule } from "../catalog/catalog.module.js";
import { ProspectsModule } from "../prospects/prospects.module.js";
import { DraftDeliveryService } from "./draft-delivery.service.js";
import { DraftsController } from "./drafts.controller.js";
import { DraftsService } from "./drafts.service.js";
import { WhatsAppManualService } from "./whatsapp-manual.service.js";

@Module({
  imports: [AuditModule, ProspectsModule, CatalogModule, CampaignsModule],
  controllers: [DraftsController],
  providers: [DraftsService, DraftDeliveryService, WhatsAppManualService],
  exports: [DraftDeliveryService],
})
export class DraftsModule {}

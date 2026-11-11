import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { EmailSettingsModule } from "../email-settings/email-settings.module.js";
import { ProspectsModule } from "../prospects/prospects.module.js";
import { CampaignsController, ContactsController, PublicController } from "./campaigns.controller.js";
import { CampaignsService } from "./campaigns.service.js";
import { EmailChannels } from "./channels.js";
import { ContactsService } from "./contacts.service.js";

@Module({
  imports: [AuditModule, ProspectsModule, EmailSettingsModule],
  controllers: [ContactsController, CampaignsController, PublicController],
  providers: [CampaignsService, ContactsService, EmailChannels],
  exports: [CampaignsService, EmailChannels],
})
export class CampaignsModule {}

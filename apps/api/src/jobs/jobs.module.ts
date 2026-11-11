import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { CampaignsModule } from "../campaigns/campaigns.module.js";
import { DraftsModule } from "../drafts/drafts.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { PrivacyModule } from "../privacy/privacy.module.js";
import { ProspectsModule } from "../prospects/prospects.module.js";
import { SequencesModule } from "../sequences/sequences.module.js";
import { JobsController } from "./jobs.controller.js";
import { JobsService } from "./jobs.service.js";
import { WorkerService } from "./worker.service.js";

/** WorkerService only runs its loop when the worker entrypoint calls `start()`; importing this module in the HTTP app never executes jobs. */
@Module({ imports: [AuditModule, SequencesModule, NotificationsModule, PrivacyModule, CampaignsModule, DraftsModule, ProspectsModule], controllers: [JobsController], providers: [JobsService, WorkerService], exports: [JobsService, WorkerService] })
export class JobsModule {}

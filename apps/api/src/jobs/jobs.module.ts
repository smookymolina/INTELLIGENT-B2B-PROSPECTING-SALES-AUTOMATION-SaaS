import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { SequencesModule } from "../sequences/sequences.module.js";
import { JobsController } from "./jobs.controller.js";
import { JobsService } from "./jobs.service.js";
import { WorkerService } from "./worker.service.js";

/** WorkerService only runs its loop when the worker entrypoint calls `start()`; importing this module in the HTTP app never executes jobs. */
@Module({ imports: [AuditModule, SequencesModule, NotificationsModule], controllers: [JobsController], providers: [JobsService, WorkerService], exports: [JobsService, WorkerService] })
export class JobsModule {}

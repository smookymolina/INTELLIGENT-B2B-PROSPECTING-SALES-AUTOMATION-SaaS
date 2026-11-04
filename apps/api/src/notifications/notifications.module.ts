import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { NotificationsController } from "./notifications.controller.js";
import { NotificationsService } from "./notifications.service.js";

/** Exports NotificationsService so other modules (crm, drafts, ...) can call `notify`; see the hook-up notes in notifications.service.ts. */
@Module({ imports: [AuditModule], controllers: [NotificationsController], providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}

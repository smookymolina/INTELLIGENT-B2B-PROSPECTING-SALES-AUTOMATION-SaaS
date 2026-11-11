import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { EmailSettingsModule } from "../email-settings/email-settings.module.js";
import { NotificationEmailController } from "./notification-email.controller.js";
import { NotificationEmailService } from "./notification-email.service.js";
import { NotificationsController } from "./notifications.controller.js";
import { NotificationsService } from "./notifications.service.js";

/** Exports NotificationsService so other modules (crm, drafts, ...) can call `notify`; see the hook-up notes in notifications.service.ts. */
@Module({ imports: [AuditModule, EmailSettingsModule], controllers: [NotificationEmailController, NotificationsController], providers: [NotificationsService, NotificationEmailService], exports: [NotificationsService] })
export class NotificationsModule {}

import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { EmailSettingsController } from "./email-settings.controller.js";
import { EmailSettingsService } from "./email-settings.service.js";

@Module({ imports: [AuditModule], controllers: [EmailSettingsController], providers: [EmailSettingsService], exports: [EmailSettingsService] })
export class EmailSettingsModule {}

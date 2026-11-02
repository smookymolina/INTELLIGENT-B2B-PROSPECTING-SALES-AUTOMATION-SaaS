import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { PrivacyController } from "./privacy.controller.js";
import { PrivacyService } from "./privacy.service.js";

@Module({
  imports: [AuditModule],
  controllers: [PrivacyController],
  providers: [PrivacyService],
})
export class PrivacyModule {}

import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { CatalogModule } from "../catalog/catalog.module.js";
import { ProspectsModule } from "../prospects/prospects.module.js";
import { DraftsController } from "./drafts.controller.js";
import { DraftsService } from "./drafts.service.js";

@Module({
  imports: [AuditModule, ProspectsModule, CatalogModule],
  controllers: [DraftsController],
  providers: [DraftsService],
})
export class DraftsModule {}

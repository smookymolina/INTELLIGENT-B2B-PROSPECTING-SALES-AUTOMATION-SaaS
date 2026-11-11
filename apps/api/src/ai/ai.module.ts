import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { CatalogModule } from "../catalog/catalog.module.js";
import { AiController } from "./ai.controller.js";
import { AiUsageService } from "./ai-usage.service.js";
import { AiService } from "./ai.service.js";
import { AiProviders } from "./providers.js";

@Module({ imports: [AuditModule, CatalogModule], controllers: [AiController], providers: [AiService, AiUsageService, AiProviders], exports: [AiService] })
export class AiModule {}

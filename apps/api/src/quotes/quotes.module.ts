import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { CatalogModule } from "../catalog/catalog.module.js";
import { QuotesController, SalesController } from "./quotes.controller.js";
import { QuotesService } from "./quotes.service.js";

@Module({ imports: [AuditModule, CatalogModule], controllers: [QuotesController, SalesController], providers: [QuotesService], exports: [QuotesService] })
export class QuotesModule {}

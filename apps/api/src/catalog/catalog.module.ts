import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { CatalogController } from "./catalog.controller.js";
import { ImportController } from "./import.controller.js";
import { ImportService } from "./import.service.js";
import { CatalogService } from "./catalog.service.js";

@Module({ imports: [AuditModule], controllers: [CatalogController, ImportController], providers: [CatalogService, ImportService], exports: [CatalogService] })
export class CatalogModule {}

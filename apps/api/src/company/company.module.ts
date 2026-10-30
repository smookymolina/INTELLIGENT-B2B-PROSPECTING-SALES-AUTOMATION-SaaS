import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { CompanyController } from "./company.controller.js";
import { CompanyService } from "./company.service.js";

@Module({ imports: [AuditModule], controllers: [CompanyController], providers: [CompanyService] })
export class CompanyModule {}

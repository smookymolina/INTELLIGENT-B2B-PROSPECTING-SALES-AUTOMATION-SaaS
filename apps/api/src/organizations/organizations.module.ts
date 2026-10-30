import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { OrganizationsController } from "./organizations.controller.js";
import { OrganizationsService } from "./organizations.service.js";

@Module({ imports: [AuditModule], controllers: [OrganizationsController], providers: [OrganizationsService] })
export class OrganizationsModule {}

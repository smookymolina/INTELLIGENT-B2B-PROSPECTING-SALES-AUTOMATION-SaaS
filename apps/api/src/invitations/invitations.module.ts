import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { InvitationsController } from "./invitations.controller.js";
import { InvitationsService } from "./invitations.service.js";

@Module({ imports: [AuditModule], controllers: [InvitationsController], providers: [InvitationsService] })
export class InvitationsModule {}

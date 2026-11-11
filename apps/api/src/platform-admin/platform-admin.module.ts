import { Module } from "@nestjs/common";
import { PlatformAdminController } from "./platform-admin.controller.js";
import { PlatformAdminGuard } from "./platform-admin.guard.js";
import { PlatformAdminService } from "./platform-admin.service.js";

@Module({ controllers: [PlatformAdminController], providers: [PlatformAdminService, PlatformAdminGuard] })
export class PlatformAdminModule {}

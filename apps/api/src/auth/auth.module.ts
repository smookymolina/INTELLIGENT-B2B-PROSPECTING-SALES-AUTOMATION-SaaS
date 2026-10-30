import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { AuthController } from "./auth.controller.js";
import { LoginThrottleService } from "./login-throttle.service.js";
import { AuthService } from "./auth.service.js";

@Module({ imports: [AuditModule], controllers: [AuthController], providers: [AuthService, LoginThrottleService] })
export class AuthModule {}

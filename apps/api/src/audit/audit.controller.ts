import { Controller, Get, Inject, Query } from "@nestjs/common";
import { AuditQuery, type AuditEventDto } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { AuditService } from "./audit.service.js";

@Controller("audit-events")
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get()
  @RequirePermission("audit:read")
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(AuditQuery)) query: AuditQuery): Promise<AuditEventDto[]> {
    return this.audit.list(auth, query.limit);
  }
}

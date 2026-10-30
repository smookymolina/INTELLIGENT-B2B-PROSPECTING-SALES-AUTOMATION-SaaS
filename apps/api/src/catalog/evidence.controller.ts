import { Body, Controller, Get, HttpCode, Inject, Post, Query } from "@nestjs/common";
import { EvidenceQuery, ResolveRefsRequest, type EvidenceDto, type ResolveRefsDto } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { EvidenceService } from "./evidence.service.js";

/** Read-only, tenant-scoped, available to every role that can read the catalog (the AI engine runs under a tenant session). */
@Controller("catalog/evidence")
export class EvidenceController {
  constructor(@Inject(EvidenceService) private readonly evidence: EvidenceService) {}

  @Get()
  @RequirePermission("catalog:read")
  get(@Auth() auth: AuthContext, @Query(new ZodPipe(EvidenceQuery)) q: EvidenceQuery): Promise<EvidenceDto> {
    return this.evidence.lookup(auth, q);
  }

  @Post("resolve")
  @HttpCode(200)
  @RequirePermission("catalog:read")
  resolve(@Auth() auth: AuthContext, @Body(new ZodPipe(ResolveRefsRequest)) body: ResolveRefsRequest): Promise<ResolveRefsDto> {
    return this.evidence.resolve(auth, body);
  }
}

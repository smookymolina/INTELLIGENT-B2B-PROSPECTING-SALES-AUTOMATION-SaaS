import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from "@nestjs/common";
import {
  CreatePrivacyRequest,
  PrivacyListQuery,
  PrivacyNoteRequest,
  RetentionRunRequest,
  SetRetentionRequest,
  UuidParam,
  type ContactDto,
  type PrivacyRequestDto,
  type PrivacyRequestListDto,
  type RetentionPolicyDto,
  type RetentionRunDto,
} from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { PrivacyService } from "./privacy.service.js";

const id = () => new ZodPipe(UuidParam);

@Controller("privacy")
export class PrivacyController {
  constructor(@Inject(PrivacyService) private readonly privacy: PrivacyService) {}

  @Put("retention")
  @RequirePermission("privacy:manage")
  setRetention(@Auth() auth: AuthContext, @Body(new ZodPipe(SetRetentionRequest)) body: SetRetentionRequest): Promise<RetentionPolicyDto> {
    return this.privacy.setRetention(auth, body);
  }

  @Get("retention")
  @RequirePermission("privacy:manage")
  getRetention(@Auth() auth: AuthContext): Promise<RetentionPolicyDto> {
    return this.privacy.getRetention(auth);
  }

  @Post("retention/run")
  @HttpCode(200)
  @RequirePermission("privacy:manage")
  run(@Auth() auth: AuthContext, @Body(new ZodPipe(RetentionRunRequest)) body: RetentionRunRequest): Promise<RetentionRunDto> {
    return this.privacy.run(auth, body.dryRun);
  }

  @Post("requests")
  @RequirePermission("privacy:manage")
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(CreatePrivacyRequest)) body: CreatePrivacyRequest): Promise<PrivacyRequestDto> {
    return this.privacy.create(auth, body);
  }

  @Get("requests")
  @RequirePermission("privacy:manage")
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(PrivacyListQuery)) q: PrivacyListQuery): Promise<PrivacyRequestListDto> {
    return this.privacy.list(auth, q);
  }

  @Get("requests/:id")
  @RequirePermission("privacy:manage")
  get(@Auth() auth: AuthContext, @Param("id", id()) rid: string): Promise<PrivacyRequestDto> {
    return this.privacy.get(auth, rid);
  }

  @Post("requests/:id/complete")
  @HttpCode(200)
  @RequirePermission("privacy:manage")
  complete(@Auth() auth: AuthContext, @Param("id", id()) rid: string): Promise<PrivacyRequestDto> {
    return this.privacy.complete(auth, rid);
  }

  @Post("requests/:id/reject")
  @HttpCode(200)
  @RequirePermission("privacy:manage")
  reject(@Auth() auth: AuthContext, @Param("id", id()) rid: string, @Body(new ZodPipe(PrivacyNoteRequest)) body: PrivacyNoteRequest): Promise<PrivacyRequestDto> {
    return this.privacy.reject(auth, rid, body.note);
  }

  @Post("contacts/:id/lift-restriction")
  @HttpCode(200)
  @RequirePermission("privacy:manage")
  lift(@Auth() auth: AuthContext, @Param("id", id()) cid: string, @Body(new ZodPipe(PrivacyNoteRequest)) body: PrivacyNoteRequest): Promise<ContactDto> {
    return this.privacy.liftRestriction(auth, cid, body.note);
  }
}

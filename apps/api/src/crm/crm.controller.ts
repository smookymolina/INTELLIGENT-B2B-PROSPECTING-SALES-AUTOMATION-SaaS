import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from "@nestjs/common";
import {
  AddNoteRequest,
  AssignRequest,
  ChangeStageRequest,
  CreateOpportunityRequest,
  OpportunityListQuery,
  PoolMemberRequest,
  RoutingSettingsRequest,
  UuidParam,
  type OpportunityDetailDto,
  type OpportunityDto,
  type OpportunityPageDto,
  type PipelineSummaryDto,
  type PoolDto,
  type PoolMemberDto,
  type RoutingSettingsDto,
} from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { CrmService } from "./crm.service.js";

const id = () => new ZodPipe(UuidParam);

/** `summary` is declared before `:id`. Sellers pass crm:read / crm:work but the database only shows them opportunities assigned to them. */
@Controller("opportunities")
export class OpportunitiesController {
  constructor(@Inject(CrmService) private readonly crm: CrmService) {}

  @Get()
  @RequirePermission("crm:read")
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(OpportunityListQuery)) q: OpportunityListQuery): Promise<OpportunityPageDto> {
    return this.crm.list(auth, q);
  }

  @Post()
  @RequirePermission("crm:manage")
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(CreateOpportunityRequest)) body: CreateOpportunityRequest): Promise<OpportunityDto> {
    return this.crm.create(auth, body);
  }

  @Get("summary")
  @RequirePermission("crm:read")
  summary(@Auth() auth: AuthContext): Promise<PipelineSummaryDto> {
    return this.crm.summary(auth);
  }

  @Get(":id")
  @RequirePermission("crm:read")
  get(@Auth() auth: AuthContext, @Param("id", id()) oid: string): Promise<OpportunityDetailDto> {
    return this.crm.get(auth, oid);
  }

  @Post(":id/stage")
  @HttpCode(200)
  @RequirePermission("crm:work")
  stage(@Auth() auth: AuthContext, @Param("id", id()) oid: string, @Body(new ZodPipe(ChangeStageRequest)) body: ChangeStageRequest): Promise<OpportunityDto> {
    return this.crm.changeStage(auth, oid, body);
  }

  @Post(":id/notes")
  @RequirePermission("crm:work")
  note(@Auth() auth: AuthContext, @Param("id", id()) oid: string, @Body(new ZodPipe(AddNoteRequest)) body: AddNoteRequest): Promise<OpportunityDetailDto> {
    return this.crm.addNote(auth, oid, body);
  }

  @Post(":id/assign")
  @HttpCode(200)
  @RequirePermission("crm:manage")
  assign(@Auth() auth: AuthContext, @Param("id", id()) oid: string, @Body(new ZodPipe(AssignRequest)) body: AssignRequest): Promise<OpportunityDto> {
    return this.crm.assign(auth, oid, body);
  }

  @Post(":id/auto-assign")
  @HttpCode(200)
  @RequirePermission("crm:manage")
  autoAssign(@Auth() auth: AuthContext, @Param("id", id()) oid: string): Promise<OpportunityDto> {
    return this.crm.autoAssign(auth, oid);
  }
}

@Controller("routing")
export class RoutingController {
  constructor(@Inject(CrmService) private readonly crm: CrmService) {}

  @Get("settings")
  @RequirePermission("crm:manage")
  settings(@Auth() auth: AuthContext): Promise<RoutingSettingsDto> {
    return this.crm.getSettings(auth);
  }

  @Put("settings")
  @RequirePermission("crm:manage")
  setSettings(@Auth() auth: AuthContext, @Body(new ZodPipe(RoutingSettingsRequest)) body: RoutingSettingsRequest): Promise<RoutingSettingsDto> {
    return this.crm.setSettings(auth, body);
  }

  @Get("pool")
  @RequirePermission("crm:manage")
  pool(@Auth() auth: AuthContext): Promise<PoolDto> {
    return this.crm.listPool(auth);
  }

  @Put("pool/:userId")
  @RequirePermission("crm:manage")
  setMember(@Auth() auth: AuthContext, @Param("userId", id()) userId: string, @Body(new ZodPipe(PoolMemberRequest)) body: PoolMemberRequest): Promise<PoolMemberDto> {
    return this.crm.setPoolMember(auth, userId, body);
  }

  @Delete("pool/:userId")
  @HttpCode(204)
  @RequirePermission("crm:manage")
  removeMember(@Auth() auth: AuthContext, @Param("userId", id()) userId: string): Promise<void> {
    return this.crm.removePoolMember(auth, userId);
  }
}

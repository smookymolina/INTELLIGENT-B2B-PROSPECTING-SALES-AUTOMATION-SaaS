import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from "@nestjs/common";
import {
  AssessReplyRequest,
  AttributeDecisionRequest,
  CreateAttributeRequest,
  LeadDecisionRequest,
  LeadListQuery,
  SaveScoringDraftRequest,
  SetLeadSettingsRequest,
  UuidParam,
  type AttributeDto,
  type AttributeListDto,
  type EvaluateLeadsDto,
  type IntentAssessmentDto,
  type IntentAssessmentListDto,
  type LeadDto,
  type LeadPageDto,
  type LeadSettingsDto,
  type ProspectScoreDto,
  type RecomputeDto,
  type ScoreResultDto,
  type ScoringModelDto,
} from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { LeadsService } from "./leads.service.js";
import { ScoringService } from "./scoring.service.js";

const id = () => new ZodPipe(UuidParam);

/** Prospect sub-resources: attributes, score and reply assessments (extra segments, so they never clash with `/prospects/:id`). */
@Controller("prospects/:id")
export class ProspectInsightsController {
  constructor(
    @Inject(ScoringService) private readonly scoring: ScoringService,
    @Inject(LeadsService) private readonly leads: LeadsService,
  ) {}

  @Get("attributes")
  @RequirePermission("prospects:read")
  attributes(@Auth() auth: AuthContext, @Param("id", id()) pid: string): Promise<AttributeListDto> {
    return this.scoring.listAttributes(auth, pid);
  }

  @Post("attributes")
  @RequirePermission("prospects:manage")
  addAttribute(@Auth() auth: AuthContext, @Param("id", id()) pid: string, @Body(new ZodPipe(CreateAttributeRequest)) body: CreateAttributeRequest): Promise<AttributeDto> {
    return this.scoring.addAttribute(auth, pid, body);
  }

  @Post("attributes/:attributeId/decision")
  @HttpCode(200)
  @RequirePermission("prospects:manage")
  decide(
    @Auth() auth: AuthContext,
    @Param("id", id()) pid: string,
    @Param("attributeId", id()) attributeId: string,
    @Body(new ZodPipe(AttributeDecisionRequest)) body: AttributeDecisionRequest,
  ): Promise<AttributeDto> {
    return this.scoring.decideAttribute(auth, pid, attributeId, body);
  }

  @Get("score")
  @RequirePermission("prospects:read")
  score(@Auth() auth: AuthContext, @Param("id", id()) pid: string): Promise<ProspectScoreDto> {
    return this.scoring.getScore(auth, pid);
  }

  @Post("score")
  @RequirePermission("prospects:manage")
  compute(@Auth() auth: AuthContext, @Param("id", id()) pid: string): Promise<ScoreResultDto> {
    return this.scoring.scoreProspect(auth, pid);
  }

  @Post("replies")
  @RequirePermission("prospects:manage")
  assess(@Auth() auth: AuthContext, @Param("id", id()) pid: string, @Body(new ZodPipe(AssessReplyRequest)) body: AssessReplyRequest): Promise<IntentAssessmentDto> {
    return this.leads.assessReply(auth, pid, body);
  }

  @Get("replies")
  @RequirePermission("prospects:read")
  replies(@Auth() auth: AuthContext, @Param("id", id()) pid: string): Promise<IntentAssessmentListDto> {
    return this.leads.listAssessments(auth, pid);
  }
}

@Controller("scoring")
export class ScoringController {
  constructor(@Inject(ScoringService) private readonly scoring: ScoringService) {}

  @Get("model")
  @RequirePermission("prospects:read")
  model(@Auth() auth: AuthContext): Promise<ScoringModelDto> {
    return this.scoring.getModel(auth);
  }

  @Put("model/draft")
  @RequirePermission("scoring:manage")
  saveDraft(@Auth() auth: AuthContext, @Body(new ZodPipe(SaveScoringDraftRequest)) body: SaveScoringDraftRequest): Promise<ScoringModelDto> {
    return this.scoring.saveDraft(auth, body);
  }

  @Post("model/approve")
  @HttpCode(200)
  @RequirePermission("scoring:approve")
  approve(@Auth() auth: AuthContext): Promise<ScoringModelDto> {
    return this.scoring.approveModel(auth);
  }

  @Post("recompute")
  @HttpCode(200)
  @RequirePermission("prospects:manage")
  recompute(@Auth() auth: AuthContext): Promise<RecomputeDto> {
    return this.scoring.recomputeAll(auth);
  }
}

/** Fixed routes (`settings`, `evaluate`) are declared before `:id`. */
@Controller("leads")
export class LeadsController {
  constructor(@Inject(LeadsService) private readonly leads: LeadsService) {}

  @Get("settings")
  @RequirePermission("leads:read")
  settings(@Auth() auth: AuthContext): Promise<LeadSettingsDto> {
    return this.leads.getSettings(auth);
  }

  @Put("settings")
  @RequirePermission("scoring:approve")
  setSettings(@Auth() auth: AuthContext, @Body(new ZodPipe(SetLeadSettingsRequest)) body: SetLeadSettingsRequest): Promise<LeadSettingsDto> {
    return this.leads.setSettings(auth, body);
  }

  @Post("evaluate")
  @HttpCode(200)
  @RequirePermission("leads:review")
  evaluate(@Auth() auth: AuthContext): Promise<EvaluateLeadsDto> {
    return this.leads.evaluate(auth);
  }

  @Get()
  @RequirePermission("leads:read")
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(LeadListQuery)) q: LeadListQuery): Promise<LeadPageDto> {
    return this.leads.list(auth, q);
  }

  @Get(":id")
  @RequirePermission("leads:read")
  get(@Auth() auth: AuthContext, @Param("id", id()) leadId: string): Promise<LeadDto> {
    return this.leads.get(auth, leadId);
  }

  @Post(":id/decision")
  @HttpCode(200)
  @RequirePermission("leads:review")
  decide(@Auth() auth: AuthContext, @Param("id", id()) leadId: string, @Body(new ZodPipe(LeadDecisionRequest)) body: LeadDecisionRequest): Promise<LeadDto> {
    return this.leads.decide(auth, leadId, body);
  }
}

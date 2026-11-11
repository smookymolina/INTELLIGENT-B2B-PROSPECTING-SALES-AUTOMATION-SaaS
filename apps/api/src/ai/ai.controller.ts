import { Body, Controller, Get, HttpCode, Inject, Post, Put, Query } from "@nestjs/common";
import { AiAnalyzeRequest, ReportMcpUsageRequest, SetMcpLimitRequest, type AiUsageSummaryDto, AiRunListQuery, SetAiBudgetRequest, type AiRunDto, type AiRunPageDto, type AiUsageDto } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { AiUsageService } from "./ai-usage.service.js";
import { AiService } from "./ai.service.js";

@Controller("ai")
export class AiController {
  constructor(
    @Inject(AiService) private readonly ai: AiService,
    @Inject(AiUsageService) private readonly usageSvc: AiUsageService,
  ) {}

  @Post("analyze")
  @RequirePermission("ai:use")
  analyze(@Auth() auth: AuthContext, @Body(new ZodPipe(AiAnalyzeRequest)) body: AiAnalyzeRequest): Promise<AiRunDto> {
    return this.ai.analyze(auth, body);
  }

  @Get("runs")
  @RequirePermission("ai:use")
  runs(@Auth() auth: AuthContext, @Query(new ZodPipe(AiRunListQuery)) q: AiRunListQuery): Promise<AiRunPageDto> {
    return this.ai.list(auth, q);
  }

  @Get("usage")
  @RequirePermission("ai:use")
  usage(@Auth() auth: AuthContext): Promise<AiUsageDto> {
    return this.ai.usage(auth);
  }

  @Put("budget")
  @RequirePermission("ai:manage")
  setBudget(@Auth() auth: AuthContext, @Body(new ZodPipe(SetAiBudgetRequest)) body: SetAiBudgetRequest): Promise<AiUsageDto> {
    return this.ai.setBudget(auth, body);
  }

  @Get("usage-summary")
  @RequirePermission("ai:use")
  usageSummary(@Auth() auth: AuthContext): Promise<AiUsageSummaryDto> {
    return this.usageSvc.summary(auth);
  }

  @Post("mcp-usage")
  @HttpCode(204)
  @RequirePermission("ai:use")
  async reportMcp(@Auth() auth: AuthContext, @Body(new ZodPipe(ReportMcpUsageRequest)) body: ReportMcpUsageRequest): Promise<void> {
    await this.usageSvc.report(auth, body);
  }

  @Put("mcp-limit")
  @RequirePermission("ai:manage")
  setMcpLimit(@Auth() auth: AuthContext, @Body(new ZodPipe(SetMcpLimitRequest)) body: SetMcpLimitRequest): Promise<AiUsageSummaryDto> {
    return this.usageSvc.setLimit(auth, body);
  }
}

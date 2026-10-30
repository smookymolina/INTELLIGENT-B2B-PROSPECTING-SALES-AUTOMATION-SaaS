import { Body, Controller, Get, Inject, Post, Put, Query } from "@nestjs/common";
import { AiAnalyzeRequest, AiRunListQuery, SetAiBudgetRequest, type AiRunDto, type AiRunPageDto, type AiUsageDto } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { AiService } from "./ai.service.js";

@Controller("ai")
export class AiController {
  constructor(@Inject(AiService) private readonly ai: AiService) {}

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
}

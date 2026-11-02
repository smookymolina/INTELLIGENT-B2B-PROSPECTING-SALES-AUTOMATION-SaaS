import { Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { MergeProspectRequest, UuidParam, type ProspectMergeDto, type ProspectMergeListDto } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { ProspectMergeService } from "./prospect-merge.service.js";

const id = () => new ZodPipe(UuidParam);

@Controller("prospects")
export class ProspectMergeController {
  constructor(@Inject(ProspectMergeService) private readonly merges: ProspectMergeService) {}

  @Post(":id/merge")
  @RequirePermission("prospects:manage")
  merge(@Auth() auth: AuthContext, @Param("id", id()) survivor: string, @Body(new ZodPipe(MergeProspectRequest)) body: MergeProspectRequest): Promise<ProspectMergeDto> {
    return this.merges.merge(auth, survivor, body);
  }

  @Get(":id/merges")
  @RequirePermission("prospects:read")
  list(@Auth() auth: AuthContext, @Param("id", id()) pid: string): Promise<ProspectMergeListDto> {
    return this.merges.list(auth, pid);
  }

  @Post(":id/merges/:mergeId/revert")
  @HttpCode(200)
  @RequirePermission("prospects:manage")
  revert(@Auth() auth: AuthContext, @Param("id", id()) survivor: string, @Param("mergeId", id()) mergeId: string): Promise<ProspectMergeDto> {
    return this.merges.revert(auth, survivor, mergeId);
  }
}

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch } from "@nestjs/common";
import { UpdateMemberRequest, UuidParam, type MemberDto } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { MembershipsService } from "./memberships.service.js";

@Controller("memberships")
export class MembershipsController {
  constructor(@Inject(MembershipsService) private readonly members: MembershipsService) {}

  @Get()
  @RequirePermission("members:read")
  list(@Auth() auth: AuthContext): Promise<MemberDto[]> {
    return this.members.list(auth);
  }

  @Patch(":id")
  @RequirePermission("members:manage")
  updateRole(
    @Auth() auth: AuthContext,
    @Param("id", new ZodPipe(UuidParam)) id: string,
    @Body(new ZodPipe(UpdateMemberRequest)) body: UpdateMemberRequest,
  ): Promise<MemberDto> {
    return this.members.updateRole(auth, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("members:manage")
  remove(@Auth() auth: AuthContext, @Param("id", new ZodPipe(UuidParam)) id: string): Promise<void> {
    return this.members.remove(auth, id);
  }
}

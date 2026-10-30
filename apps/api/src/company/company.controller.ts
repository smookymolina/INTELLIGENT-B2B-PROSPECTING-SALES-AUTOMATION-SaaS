import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put } from "@nestjs/common";
import {
  CreateBranchRequest,
  UpdateBranchRequest,
  UpdateProfileRequest,
  UuidParam,
  type BranchDto,
  type ProfileDto,
} from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { CompanyService } from "./company.service.js";

/** Tenant is always the caller's own (from the session); no organization id appears in paths or bodies. */
@Controller()
export class CompanyController {
  constructor(@Inject(CompanyService) private readonly company: CompanyService) {}

  @Get("organization/profile")
  @RequirePermission("organization:read")
  getProfile(@Auth() auth: AuthContext): Promise<ProfileDto> {
    return this.company.getProfile(auth);
  }

  @Put("organization/profile")
  @RequirePermission("organization:update")
  replaceProfile(@Auth() auth: AuthContext, @Body(new ZodPipe(UpdateProfileRequest)) body: UpdateProfileRequest): Promise<ProfileDto> {
    return this.company.replaceProfile(auth, body);
  }

  @Get("branches")
  @RequirePermission("organization:read")
  listBranches(@Auth() auth: AuthContext): Promise<BranchDto[]> {
    return this.company.listBranches(auth);
  }

  @Post("branches")
  @RequirePermission("organization:update")
  createBranch(@Auth() auth: AuthContext, @Body(new ZodPipe(CreateBranchRequest)) body: CreateBranchRequest): Promise<BranchDto> {
    return this.company.createBranch(auth, body);
  }

  @Patch("branches/:id")
  @HttpCode(200)
  @RequirePermission("organization:update")
  updateBranch(
    @Auth() auth: AuthContext,
    @Param("id", new ZodPipe(UuidParam)) id: string,
    @Body(new ZodPipe(UpdateBranchRequest)) body: UpdateBranchRequest,
  ): Promise<BranchDto> {
    return this.company.updateBranch(auth, id, body);
  }
}

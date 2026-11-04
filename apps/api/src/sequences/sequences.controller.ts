import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from "@nestjs/common";
import {
  EnrollmentListQuery,
  RunDueRequest,
  SaveSequenceRequest,
  UuidParam,
  type EnrollmentPageDto,
  type EnrollResultDto,
  type RunDueResultDto,
  type SequenceDto,
} from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { SequencesService } from "./sequences.service.js";

const id = () => new ZodPipe(UuidParam);

@Controller("campaigns/:id/sequence")
export class SequencesController {
  constructor(@Inject(SequencesService) private readonly sequences: SequencesService) {}

  @Get()
  @RequirePermission("campaigns:read")
  get(@Auth() auth: AuthContext, @Param("id", id()) cid: string): Promise<SequenceDto> {
    return this.sequences.get(auth, cid);
  }

  @Put()
  @RequirePermission("campaigns:manage")
  save(@Auth() auth: AuthContext, @Param("id", id()) cid: string, @Body(new ZodPipe(SaveSequenceRequest)) body: SaveSequenceRequest): Promise<SequenceDto> {
    return this.sequences.save(auth, cid, body);
  }

  @Post("enroll")
  @HttpCode(200)
  @RequirePermission("campaigns:manage")
  enroll(@Auth() auth: AuthContext, @Param("id", id()) cid: string): Promise<EnrollResultDto> {
    return this.sequences.enroll(auth, cid);
  }

  @Post("run-due")
  @HttpCode(200)
  @RequirePermission("campaigns:manage")
  runDue(@Auth() auth: AuthContext, @Param("id", id()) cid: string, @Body(new ZodPipe(RunDueRequest.default({ limit: 50 }))) body: RunDueRequest): Promise<RunDueResultDto> {
    return this.sequences.runDue(auth, cid, body.limit);
  }

  @Get("enrollments")
  @RequirePermission("campaigns:read")
  enrollments(@Auth() auth: AuthContext, @Param("id", id()) cid: string, @Query(new ZodPipe(EnrollmentListQuery)) q: EnrollmentListQuery): Promise<EnrollmentPageDto> {
    return this.sequences.enrollments(auth, cid, q);
  }
}

import { Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { JobListQuery, UuidParam, type JobDto, type JobPageDto, type JobStatsDto } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { JobsService } from "./jobs.service.js";

/** Admin view of the worker queue: list/inspect the dead-letter queue and requeue a job (audited). Nothing here executes work. */
@Controller("admin/jobs")
export class JobsController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}

  @Get()
  @RequirePermission("jobs:manage")
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(JobListQuery)) q: JobListQuery): Promise<JobPageDto> {
    return this.jobs.list(auth, q);
  }

  @Get("stats")
  @RequirePermission("jobs:manage")
  stats(@Auth() auth: AuthContext): Promise<JobStatsDto> {
    return this.jobs.stats(auth);
  }

  @Post(":id/requeue")
  @HttpCode(200)
  @RequirePermission("jobs:manage")
  requeue(@Auth() auth: AuthContext, @Param("id", new ZodPipe(UuidParam)) id: string): Promise<JobDto> {
    return this.jobs.requeue(auth, id);
  }
}

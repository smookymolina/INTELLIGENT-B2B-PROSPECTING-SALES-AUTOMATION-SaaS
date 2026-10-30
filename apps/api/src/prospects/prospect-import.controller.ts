import { createHash } from "node:crypto";
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res } from "@nestjs/common";
import {
  IdempotencyKeyHeader,
  ImportRequest,
  PageQuery,
  UuidParam,
  type ProspectImportJobDto,
  type ProspectImportJobPageDto,
  type ProspectImportResultDto,
} from "@prospecting/contracts";
import type { Response } from "express";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { IdempotencyService } from "../http/idempotency.service.js";
import { ProspectImportService } from "./prospect-import.service.js";

const keyPipe = new ZodPipe(IdempotencyKeyHeader);

/** Registered before ProspectsController so `/prospects/imports` is never captured by `/prospects/:id`. */
@Controller("prospects/imports")
export class ProspectImportController {
  constructor(
    @Inject(ProspectImportService) private readonly imports: ProspectImportService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @HttpCode(200)
  @RequirePermission("prospects:manage")
  async run(
    @Auth() auth: AuthContext,
    @Body(new ZodPipe(ImportRequest)) body: ImportRequest,
    @Headers() headers: Record<string, string | undefined>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProspectImportResultDto> {
    const key = keyPipe.transform(headers["idempotency-key"]);
    const fingerprint = { mode: body.mode, csv: createHash("sha256").update(body.csv).digest("hex") };
    const { value, replayed } = await this.idempotency.run({ scope: `prospect-imports:${auth.organizationId}`, key, fingerprint }, () => this.imports.run(auth, body));
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return value;
  }

  @Get()
  @RequirePermission("prospects:manage")
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(PageQuery)) q: PageQuery): Promise<ProspectImportJobPageDto> {
    return this.imports.listJobs(auth, q);
  }

  @Get(":id")
  @RequirePermission("prospects:manage")
  get(@Auth() auth: AuthContext, @Param("id", new ZodPipe(UuidParam)) id: string): Promise<ProspectImportJobDto> {
    return this.imports.getJob(auth, id);
  }
}

import { createHash } from "node:crypto";
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res } from "@nestjs/common";
import { IdempotencyKeyHeader, ImportRequest, PageQuery, UuidParam, type ImportJobDto, type ImportJobPageDto, type ImportResultDto } from "@prospecting/contracts";
import type { Response } from "express";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { IdempotencyService } from "../http/idempotency.service.js";
import { ImportService } from "./import.service.js";

const keyPipe = new ZodPipe(IdempotencyKeyHeader);

/** CSV import of catalog items. Requires catalog:manage; it can only create/update drafts (approval is catalog:approve). */
@Controller("catalog/imports")
export class ImportController {
  constructor(
    @Inject(ImportService) private readonly imports: ImportService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @HttpCode(200)
  @RequirePermission("catalog:manage")
  async run(
    @Auth() auth: AuthContext,
    @Body(new ZodPipe(ImportRequest)) body: ImportRequest,
    @Headers() headers: Record<string, string | undefined>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ImportResultDto> {
    const key = keyPipe.transform(headers["idempotency-key"]);
    const fingerprint = { mode: body.mode, csv: createHash("sha256").update(body.csv).digest("hex") };
    const { value, replayed } = await this.idempotency.run({ scope: `imports:${auth.organizationId}`, key, fingerprint }, () => this.imports.run(auth, body));
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return value;
  }

  @Get()
  @RequirePermission("catalog:manage")
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(PageQuery)) q: PageQuery): Promise<ImportJobPageDto> {
    return this.imports.listJobs(auth, q);
  }

  @Get(":id")
  @RequirePermission("catalog:manage")
  get(@Auth() auth: AuthContext, @Param("id", new ZodPipe(UuidParam)) id: string): Promise<ImportJobDto> {
    return this.imports.getJob(auth, id);
  }
}

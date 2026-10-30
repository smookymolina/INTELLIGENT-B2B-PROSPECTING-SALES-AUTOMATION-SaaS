import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Post, Res } from "@nestjs/common";
import {
  AcceptInvitationRequest,
  CreateInvitationRequest,
  IdempotencyKeyHeader,
  UuidParam,
  type AcceptedInvitationDto,
  type InvitationCreatedDto,
  type InvitationDto,
} from "@prospecting/contracts";
import type { Response } from "express";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { IdempotencyService } from "../http/idempotency.service.js";
import { InvitationsService } from "./invitations.service.js";

const keyPipe = new ZodPipe(IdempotencyKeyHeader);

@Controller("invitations")
export class InvitationsController {
  constructor(
    @Inject(InvitationsService) private readonly invitations: InvitationsService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @RequirePermission("members:manage")
  async create(
    @Auth() auth: AuthContext,
    @Body(new ZodPipe(CreateInvitationRequest)) body: CreateInvitationRequest,
    @Headers() headers: Record<string, string | undefined>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvitationCreatedDto> {
    const key = keyPipe.transform(headers["idempotency-key"]);
    // Scope comes from the verified session, so keys can never collide or leak across organizations.
    const { value, replayed } = await this.idempotency.run({ scope: `invitations:${auth.organizationId}`, key, fingerprint: body }, () => this.invitations.create(auth, body));
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return value;
  }

  @Get()
  @RequirePermission("members:manage")
  list(@Auth() auth: AuthContext): Promise<InvitationDto[]> {
    return this.invitations.list(auth);
  }

  /** Any authenticated user may try a token; only the invited email can succeed. Declared before `:id` routes for clarity. */
  @Post("accept")
  @HttpCode(200)
  accept(@Auth() auth: AuthContext, @Body(new ZodPipe(AcceptInvitationRequest)) body: AcceptInvitationRequest): Promise<AcceptedInvitationDto> {
    return this.invitations.accept(auth, body.token);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("members:manage")
  revoke(@Auth() auth: AuthContext, @Param("id", new ZodPipe(UuidParam)) id: string): Promise<void> {
    return this.invitations.revoke(auth, id);
  }
}

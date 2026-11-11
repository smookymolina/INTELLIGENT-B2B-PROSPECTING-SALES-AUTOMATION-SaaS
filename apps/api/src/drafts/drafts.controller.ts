import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import {
  CreateDraftRequest,
  DraftListQuery,
  RejectDraftRequest,
  UuidParam,
  type DraftDeliveryDto,
  type MessageDraftDto,
  type MessageDraftPageDto,
  type OutreachContextDto,
} from "@prospecting/contracts";
import { DraftDeliveryService } from "./draft-delivery.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { DraftsService } from "./drafts.service.js";

const id = () => new ZodPipe(UuidParam);

@Controller()
export class DraftsController {
  constructor(
    @Inject(DraftsService) private readonly drafts: DraftsService,
    @Inject(DraftDeliveryService) private readonly deliveries: DraftDeliveryService,
  ) {}

  @Get("message-drafts/:id/delivery")
  @RequirePermission("campaigns:read")
  delivery(@Auth() auth: AuthContext, @Param("id", id()) did: string): Promise<DraftDeliveryDto> {
    return this.deliveries.get(auth, did);
  }

  /** Queues the delivery; the worker sends it. Nothing leaves the system inside this request. */
  @Post("message-drafts/:id/send")
  @HttpCode(200)
  @RequirePermission("campaigns:approve")
  send(@Auth() auth: AuthContext, @Param("id", id()) did: string): Promise<DraftDeliveryDto> {
    return this.deliveries.queue(auth, did);
  }

  @Get("contacts/:id/outreach-context")
  @RequirePermission("campaigns:read")
  context(@Auth() auth: AuthContext, @Param("id", id()) cid: string): Promise<OutreachContextDto> {
    return this.drafts.context(auth, cid);
  }

  /** `X-Client-Kind: mcp` only labels provenance; it never changes what the caller may do. */
  @Post("message-drafts")
  @RequirePermission("campaigns:manage")
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(CreateDraftRequest)) body: CreateDraftRequest, @Headers("x-client-kind") kind?: string): Promise<MessageDraftDto> {
    return this.drafts.create(auth, body, kind?.trim().toLowerCase());
  }

  @Get("message-drafts")
  @RequirePermission("campaigns:read")
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(DraftListQuery)) q: DraftListQuery): Promise<MessageDraftPageDto> {
    return this.drafts.list(auth, q);
  }

  @Get("message-drafts/:id")
  @RequirePermission("campaigns:read")
  get(@Auth() auth: AuthContext, @Param("id", id()) did: string): Promise<MessageDraftDto> {
    return this.drafts.get(auth, did);
  }

  @Post("message-drafts/:id/approve")
  @HttpCode(200)
  @RequirePermission("campaigns:approve")
  approve(@Auth() auth: AuthContext, @Param("id", id()) did: string): Promise<MessageDraftDto> {
    return this.drafts.approve(auth, did);
  }

  @Post("message-drafts/:id/reject")
  @HttpCode(200)
  @RequirePermission("campaigns:approve")
  reject(@Auth() auth: AuthContext, @Param("id", id()) did: string, @Body(new ZodPipe(RejectDraftRequest)) body: RejectDraftRequest): Promise<MessageDraftDto> {
    return this.drafts.reject(auth, did, body);
  }
}

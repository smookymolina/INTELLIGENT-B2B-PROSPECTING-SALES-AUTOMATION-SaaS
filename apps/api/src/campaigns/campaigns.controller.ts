import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import {
  AddContactRequest,
  AttemptListQuery,
  CampaignListQuery,
  CreateCampaignRequest,
  DispatchRequest,
  RecordConsentRequest,
  UnsubscribeRequest,
  UpdateCampaignRequest,
  UuidParam,
  type AttemptPageDto,
  type AudiencePreviewDto,
  type CampaignDto,
  type CampaignPageDto,
  type ContactDto,
  type ContactListDto,
  type DispatchResultDto,
} from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, Public, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { CampaignsService } from "./campaigns.service.js";
import { ContactsService } from "./contacts.service.js";

const id = () => new ZodPipe(UuidParam);

@Controller()
export class ContactsController {
  constructor(@Inject(ContactsService) private readonly contacts: ContactsService) {}

  @Post("prospects/:id/contacts")
  @RequirePermission("prospects:manage")
  add(@Auth() auth: AuthContext, @Param("id", id()) pid: string, @Body(new ZodPipe(AddContactRequest)) body: AddContactRequest): Promise<ContactDto> {
    return this.contacts.add(auth, pid, body);
  }

  @Get("prospects/:id/contacts")
  @RequirePermission("campaigns:read")
  list(@Auth() auth: AuthContext, @Param("id", id()) pid: string): Promise<ContactListDto> {
    return this.contacts.list(auth, pid);
  }

  @Post("contacts/:id/consent")
  @RequirePermission("prospects:manage")
  consent(@Auth() auth: AuthContext, @Param("id", id()) cid: string, @Body(new ZodPipe(RecordConsentRequest)) body: RecordConsentRequest): Promise<ContactDto> {
    return this.contacts.record(auth, cid, body);
  }
}

@Controller("campaigns")
export class CampaignsController {
  constructor(@Inject(CampaignsService) private readonly campaigns: CampaignsService) {}

  @Post()
  @RequirePermission("campaigns:manage")
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(CreateCampaignRequest)) body: CreateCampaignRequest): Promise<CampaignDto> {
    return this.campaigns.create(auth, body);
  }

  @Get()
  @RequirePermission("campaigns:read")
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(CampaignListQuery)) q: CampaignListQuery): Promise<CampaignPageDto> {
    return this.campaigns.list(auth, q);
  }

  @Get(":id")
  @RequirePermission("campaigns:read")
  get(@Auth() auth: AuthContext, @Param("id", id()) cid: string): Promise<CampaignDto> {
    return this.campaigns.get(auth, cid);
  }

  @Patch(":id")
  @RequirePermission("campaigns:manage")
  update(@Auth() auth: AuthContext, @Param("id", id()) cid: string, @Body(new ZodPipe(UpdateCampaignRequest)) body: UpdateCampaignRequest): Promise<CampaignDto> {
    return this.campaigns.update(auth, cid, body);
  }

  @Post(":id/approve")
  @HttpCode(200)
  @RequirePermission("campaigns:approve")
  approve(@Auth() auth: AuthContext, @Param("id", id()) cid: string): Promise<CampaignDto> {
    return this.campaigns.approve(auth, cid);
  }

  @Get(":id/preview")
  @RequirePermission("campaigns:read")
  preview(@Auth() auth: AuthContext, @Param("id", id()) cid: string): Promise<AudiencePreviewDto> {
    return this.campaigns.preview(auth, cid);
  }

  @Post(":id/launch")
  @HttpCode(200)
  @RequirePermission("campaigns:manage")
  launch(@Auth() auth: AuthContext, @Param("id", id()) cid: string): Promise<CampaignDto> {
    return this.campaigns.launch(auth, cid);
  }

  @Post(":id/dispatch")
  @HttpCode(200)
  @RequirePermission("campaigns:manage")
  dispatch(@Auth() auth: AuthContext, @Param("id", id()) cid: string, @Body(new ZodPipe(DispatchRequest.default({ limit: 50 }))) body: DispatchRequest): Promise<DispatchResultDto> {
    return this.campaigns.dispatch(auth, cid, body.limit);
  }

  @Post(":id/pause")
  @HttpCode(200)
  @RequirePermission("campaigns:manage")
  pause(@Auth() auth: AuthContext, @Param("id", id()) cid: string): Promise<CampaignDto> {
    return this.campaigns.pause(auth, cid);
  }

  @Post(":id/resume")
  @HttpCode(200)
  @RequirePermission("campaigns:manage")
  resume(@Auth() auth: AuthContext, @Param("id", id()) cid: string): Promise<CampaignDto> {
    return this.campaigns.resume(auth, cid);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @RequirePermission("campaigns:manage")
  cancel(@Auth() auth: AuthContext, @Param("id", id()) cid: string): Promise<CampaignDto> {
    return this.campaigns.cancel(auth, cid);
  }

  @Get(":id/attempts")
  @RequirePermission("campaigns:read")
  attempts(@Auth() auth: AuthContext, @Param("id", id()) cid: string, @Query(new ZodPipe(AttemptListQuery)) q: AttemptListQuery): Promise<AttemptPageDto> {
    return this.campaigns.attempts(auth, cid, q);
  }
}

@Controller("public")
export class PublicController {
  constructor(@Inject(CampaignsService) private readonly campaigns: CampaignsService) {}

  @Public()
  @Post("unsubscribe")
  @HttpCode(204)
  unsubscribe(@Body(new ZodPipe(UnsubscribeRequest)) body: UnsubscribeRequest): Promise<void> {
    return this.campaigns.unsubscribe(body);
  }
}

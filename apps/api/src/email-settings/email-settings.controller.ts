import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Put, Query } from "@nestjs/common";
import { EmailSettingsPurposeQuery, TestEmailSettingsRequest, UpdateEmailSettingsRequest, type EmailSettingsDto, type EmailSettingsTestDto } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { EmailSettingsService } from "./email-settings.service.js";

/** `?purpose=outreach|notifications` (default outreach) picks the account. The tenant is always the caller's own. Even reading needs organization:update: the login name and server are operational secrets-adjacent data. */
@Controller("organization/email-settings")
export class EmailSettingsController {
  constructor(@Inject(EmailSettingsService) private readonly settings: EmailSettingsService) {}

  @Get()
  @RequirePermission("organization:update")
  get(@Auth() auth: AuthContext, @Query(new ZodPipe(EmailSettingsPurposeQuery)) q: EmailSettingsPurposeQuery): Promise<EmailSettingsDto> {
    return this.settings.get(auth, q.purpose);
  }

  @Put()
  @RequirePermission("organization:update")
  replace(@Auth() auth: AuthContext, @Body(new ZodPipe(UpdateEmailSettingsRequest)) body: UpdateEmailSettingsRequest, @Query(new ZodPipe(EmailSettingsPurposeQuery)) q: EmailSettingsPurposeQuery): Promise<EmailSettingsDto> {
    return this.settings.replace(auth, body, q.purpose);
  }

  @Delete()
  @HttpCode(200)
  @RequirePermission("organization:update")
  remove(@Auth() auth: AuthContext, @Query(new ZodPipe(EmailSettingsPurposeQuery)) q: EmailSettingsPurposeQuery): Promise<EmailSettingsDto> {
    return this.settings.remove(auth, q.purpose);
  }

  @Post("test")
  @HttpCode(200)
  @RequirePermission("organization:update")
  test(@Auth() auth: AuthContext, @Body(new ZodPipe(TestEmailSettingsRequest)) body: TestEmailSettingsRequest, @Query(new ZodPipe(EmailSettingsPurposeQuery)) q: EmailSettingsPurposeQuery): Promise<EmailSettingsTestDto> {
    return this.settings.test(auth, body, q.purpose);
  }
}

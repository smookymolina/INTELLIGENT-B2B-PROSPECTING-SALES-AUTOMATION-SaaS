import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Put } from "@nestjs/common";
import { TestEmailSettingsRequest, UpdateEmailSettingsRequest, type EmailSettingsDto, type EmailSettingsTestDto } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { EmailSettingsService } from "./email-settings.service.js";

/** The tenant is always the caller's own. Even reading needs organization:update: the login name and server are operational secrets-adjacent data. */
@Controller("organization/email-settings")
export class EmailSettingsController {
  constructor(@Inject(EmailSettingsService) private readonly settings: EmailSettingsService) {}

  @Get()
  @RequirePermission("organization:update")
  get(@Auth() auth: AuthContext): Promise<EmailSettingsDto> {
    return this.settings.get(auth);
  }

  @Put()
  @RequirePermission("organization:update")
  replace(@Auth() auth: AuthContext, @Body(new ZodPipe(UpdateEmailSettingsRequest)) body: UpdateEmailSettingsRequest): Promise<EmailSettingsDto> {
    return this.settings.replace(auth, body);
  }

  @Delete()
  @HttpCode(200)
  @RequirePermission("organization:update")
  remove(@Auth() auth: AuthContext): Promise<EmailSettingsDto> {
    return this.settings.remove(auth);
  }

  @Post("test")
  @HttpCode(200)
  @RequirePermission("organization:update")
  test(@Auth() auth: AuthContext, @Body(new ZodPipe(TestEmailSettingsRequest)) body: TestEmailSettingsRequest): Promise<EmailSettingsTestDto> {
    return this.settings.test(auth, body);
  }
}

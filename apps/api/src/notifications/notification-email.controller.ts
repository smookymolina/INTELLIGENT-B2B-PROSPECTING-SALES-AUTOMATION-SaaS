import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from "@nestjs/common";
import { UpdateNotificationEmailDestinationsRequest, UuidParam, type NotificationEmailDestinationsDto, type NotificationEmailTestQueuedDto } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { NotificationEmailService } from "./notification-email.service.js";

/** Where the app's notifications are also e-mailed. Organization administrators only (organization:update), like the SMTP settings. */
@Controller("notifications/email-destinations")
export class NotificationEmailController {
  constructor(@Inject(NotificationEmailService) private readonly email: NotificationEmailService) {}

  @Get()
  @RequirePermission("organization:update")
  get(@Auth() auth: AuthContext): Promise<NotificationEmailDestinationsDto> {
    return this.email.get(auth);
  }

  @Put()
  @RequirePermission("organization:update")
  replace(@Auth() auth: AuthContext, @Body(new ZodPipe(UpdateNotificationEmailDestinationsRequest)) body: UpdateNotificationEmailDestinationsRequest): Promise<NotificationEmailDestinationsDto> {
    return this.email.replace(auth, body);
  }

  /** Queues a test message; the worker sends it (never inside this request). */
  @Post(":id/test")
  @HttpCode(202)
  @RequirePermission("organization:update")
  test(@Auth() auth: AuthContext, @Param("id", new ZodPipe(UuidParam)) id: string): Promise<NotificationEmailTestQueuedDto> {
    return this.email.testDestination(auth, id);
  }
}

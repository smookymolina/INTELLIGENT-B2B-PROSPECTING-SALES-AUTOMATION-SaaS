import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from "@nestjs/common";
import {
  NotificationListQuery,
  UpdateNotificationPreferencesRequest,
  UuidParam,
  type NotificationCountDto,
  type NotificationDto,
  type NotificationPageDto,
  type NotificationPreferencesDto,
  type NotificationReadAllDto,
} from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { NotificationsService } from "./notifications.service.js";

/** Every role may read its own inbox (organization:read); the database restricts rows to the caller. */
@Controller("notifications")
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermission("organization:read")
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(NotificationListQuery)) q: NotificationListQuery): Promise<NotificationPageDto> {
    return this.notifications.list(auth, q);
  }

  @Get("unread-count")
  @RequirePermission("organization:read")
  count(@Auth() auth: AuthContext): Promise<NotificationCountDto> {
    return this.notifications.unreadCount(auth);
  }

  @Post("read-all")
  @HttpCode(200)
  @RequirePermission("organization:read")
  readAll(@Auth() auth: AuthContext): Promise<NotificationReadAllDto> {
    return this.notifications.markAllRead(auth);
  }

  @Get("preferences")
  @RequirePermission("organization:read")
  preferences(@Auth() auth: AuthContext): Promise<NotificationPreferencesDto> {
    return this.notifications.getPreferences(auth);
  }

  @Put("preferences")
  @RequirePermission("organization:read")
  setPreferences(@Auth() auth: AuthContext, @Body(new ZodPipe(UpdateNotificationPreferencesRequest)) body: UpdateNotificationPreferencesRequest): Promise<NotificationPreferencesDto> {
    return this.notifications.setPreferences(auth, body);
  }

  @Post(":id/read")
  @HttpCode(200)
  @RequirePermission("organization:read")
  read(@Auth() auth: AuthContext, @Param("id", new ZodPipe(UuidParam)) id: string): Promise<NotificationDto> {
    return this.notifications.markRead(auth, id);
  }
}

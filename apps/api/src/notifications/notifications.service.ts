import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  NOTIFICATION_TYPES,
  type NotificationCountDto,
  type NotificationDto,
  type NotificationListQuery,
  type NotificationPageDto,
  type NotificationPreferencesDto,
  type NotificationReadAllDto,
  type NotificationType,
  type UpdateNotificationPreferencesRequest,
} from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService, type TenantContext, type Tx } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";

export type NotifyInput = {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  /** Unique per (organization, user): repeating the same key never creates a second notification. */
  dedupeKey: string;
};

type Row = {
  id: string; type: string; title: string; body: string | null; resource_type: string | null; resource_id: string | null; channel: string; created_at: Date; read_at: Date | null;
};
const toDto = (r: Row): NotificationDto => ({
  id: r.id, type: r.type as NotificationType, title: r.title, body: r.body, resourceType: r.resource_type, resourceId: r.resource_id, channel: "sandbox",
  createdAt: r.created_at.toISOString(), readAt: r.read_at?.toISOString() ?? null,
});

const DAY_MS = 86_400_000;

/**
 * In-app inbox (sandbox channel: nothing is emailed or sent over WhatsApp).
 *
 * Where to hook it up (other modules are NOT modified here; import NotificationsModule and inject NotificationsService):
 *  - crm: after assigning an opportunity inside the assign transaction -> `notifyInTx(tx, org, { type: "opportunity_assigned", userId: newOwner, dedupeKey: `opp-assigned:${oppId}:${newOwner}:${historyId}` ... })`.
 *  - leads/routing: lead assignment -> type "lead_assigned", key `lead-assigned:${leadId}:${userId}`.
 *  - SLA checker: breach -> "sla_breached", key `sla:${resourceId}:${deadlineIso}`.
 *  - drafts: draft enters review -> "draft_pending_review", key `draft-review:${draftId}:${version}`.
 *  - worker: call `scanDue(ctx)` periodically per organization for task_overdue / task_due_soon.
 * Visibility is enforced by PostgreSQL: a user can only read or update their own rows, in their own organization.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Creates a notification inside the caller's transaction. Returns false when the recipient disabled the type or the dedupe key already exists. */
  async notifyInTx(tx: Tx, organizationId: string, input: NotifyInput): Promise<boolean> {
    const pref = await tx.notificationPreference.findFirst({ where: { organization_id: organizationId, user_id: input.userId, type: input.type }, select: { enabled: true } });
    if (pref && !pref.enabled) return false;
    const res = await tx.notification.createMany({
      data: [{
        organization_id: organizationId, user_id: input.userId, type: input.type, title: input.title, body: input.body ?? null,
        resource_type: input.resourceType ?? null, resource_id: input.resourceId ?? null, dedupe_key: input.dedupeKey, channel: "sandbox",
      }],
      skipDuplicates: true,
    });
    return res.count === 1;
  }

  /** Same as notifyInTx in its own tenant transaction (for callers without an open one). */
  notify(ctx: TenantContext, input: NotifyInput): Promise<boolean> {
    return this.db.withTenant(ctx, (tx) => this.notifyInTx(tx, ctx.organizationId, input)).catch((e: unknown) => {
      if (String((e as { message?: string }).message ?? "").includes("not a member")) throw new ApiException(409, "CONFLICT", "The recipient is not a member of this organization");
      throw e;
    });
  }

  /**
   * Worker entry point (one organization per call, run with a manager/admin context so every open task is visible).
   * Emits task_overdue for open tasks past due and task_due_soon for those due within `windowMs`; idempotent per task.
   */
  scanDue(ctx: TenantContext, opts: { now?: Date; windowMs?: number } = {}): Promise<{ overdue: number; dueSoon: number }> {
    const now = opts.now ?? new Date();
    const soon = new Date(now.getTime() + (opts.windowMs ?? DAY_MS));
    return this.db.withTenant(ctx, async (tx) => {
      const tasks = await tx.opportunityTask.findMany({
        where: { organization_id: ctx.organizationId, state: "open", due_at: { lte: soon } },
        select: { id: true, title: true, due_at: true, assignee_user_id: true, opportunity_id: true },
        orderBy: [{ due_at: "asc" }, { id: "asc" }],
        take: 1000,
      });
      let overdue = 0;
      let dueSoon = 0;
      for (const t of tasks) {
        const isOverdue = t.due_at.getTime() < now.getTime();
        const created = await this.notifyInTx(tx, ctx.organizationId, {
          userId: t.assignee_user_id,
          type: isOverdue ? "task_overdue" : "task_due_soon",
          title: isOverdue ? `Tarea vencida: ${t.title}` : `Tarea por vencer: ${t.title}`,
          body: `Vence ${t.due_at.toISOString()}`,
          resourceType: "opportunity_task",
          resourceId: t.id,
          dedupeKey: `${isOverdue ? "task-overdue" : "task-due-soon"}:${t.id}`,
        });
        if (created && isOverdue) overdue++;
        else if (created) dueSoon++;
      }
      return { overdue, dueSoon };
    });
  }

  list(auth: AuthContext, q: NotificationListQuery): Promise<NotificationPageDto> {
    return this.db.withTenant(auth, async (tx) => {
      const cursor = q.cursor ? await tx.notification.findFirst({ where: { id: q.cursor, organization_id: auth.organizationId, user_id: auth.userId }, select: { id: true, created_at: true } }) : null;
      if (q.cursor && !cursor) throw new NotFoundException();
      const rows = await tx.notification.findMany({
        where: {
          organization_id: auth.organizationId,
          user_id: auth.userId,
          ...(q.unread === "true" ? { read_at: null } : {}),
          ...(cursor ? { OR: [{ created_at: { lt: cursor.created_at } }, { created_at: cursor.created_at, id: { lt: cursor.id } }] } : {}),
        },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      return { items: page.map(toDto), nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
    });
  }

  unreadCount(auth: AuthContext): Promise<NotificationCountDto> {
    return this.db.withTenant(auth, async (tx) => ({ unread: await tx.notification.count({ where: { organization_id: auth.organizationId, user_id: auth.userId, read_at: null } }) }));
  }

  markRead(auth: AuthContext, id: string): Promise<NotificationDto> {
    return this.db.withTenant(auth, async (tx) => {
      const found = await tx.notification.findFirst({ where: { id, organization_id: auth.organizationId, user_id: auth.userId } });
      if (!found) throw new NotFoundException();
      // read_at is stamped by the database trigger and never moves once set.
      return toDto(found.read_at ? found : await tx.notification.update({ where: { id }, data: { read_at: new Date() } }));
    });
  }

  markAllRead(auth: AuthContext): Promise<NotificationReadAllDto> {
    return this.db.withTenant(auth, async (tx) => {
      const r = await tx.notification.updateMany({ where: { organization_id: auth.organizationId, user_id: auth.userId, read_at: null }, data: { read_at: new Date() } });
      return { updated: r.count };
    });
  }

  getPreferences(auth: AuthContext): Promise<NotificationPreferencesDto> {
    return this.db.withTenant(auth, (tx) => this.prefs(tx, auth));
  }

  setPreferences(auth: AuthContext, input: UpdateNotificationPreferencesRequest): Promise<NotificationPreferencesDto> {
    return this.db.withTenant(auth, async (tx) => {
      const changes = new Map(input.preferences.map((p) => [p.type, p.enabled]));
      for (const [type, enabled] of changes) {
        await tx.notificationPreference.upsert({
          where: { organization_id_user_id_type: { organization_id: auth.organizationId, user_id: auth.userId, type } },
          create: { organization_id: auth.organizationId, user_id: auth.userId, type, enabled },
          update: { enabled, updated_at: new Date() },
        });
      }
      await this.audit.record(tx, auth, { action: "notification.preferences_updated", resourceType: "notification_preferences", resourceId: auth.userId, metadata: { changes: Object.fromEntries(changes) } });
      return this.prefs(tx, auth);
    });
  }

  private async prefs(tx: Tx, auth: AuthContext): Promise<NotificationPreferencesDto> {
    const rows = await tx.notificationPreference.findMany({ where: { organization_id: auth.organizationId, user_id: auth.userId }, select: { type: true, enabled: true } });
    const byType = new Map(rows.map((r) => [r.type, r.enabled]));
    return { items: NOTIFICATION_TYPES.map((type) => ({ type, enabled: byType.get(type) ?? true })) };
  }
}

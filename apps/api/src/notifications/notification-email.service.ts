import { Inject, Injectable } from "@nestjs/common";
import {
  MAX_NOTIFICATION_DESTINATIONS,
  NOTIFICATION_TYPES,
  type NotificationEmailDestinationsDto,
  type NotificationEmailTestQueuedDto,
  type NotificationType,
  type UpdateNotificationEmailDestinationsRequest,
} from "@prospecting/contracts";
import { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService, type TenantContext, type Tx } from "../db/prisma.service.js";
import { EmailSettingsService } from "../email-settings/email-settings.service.js";
import { SmtpEmailAdapter, classifySmtpError } from "../email-settings/smtp.js";
import { ApiException } from "../http/api-exception.js";

/** Payload of a `notifications.send_email` job. Only ids and the event type travel in it: no titles, names or prospect data. */
export const SendEmailPayload = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("notification"), notificationId: z.uuid(), type: z.enum(NOTIFICATION_TYPES) }),
  z.strictObject({ kind: z.literal("test"), destinationId: z.uuid() }),
]);
export type SendEmailPayload = z.infer<typeof SendEmailPayload>;

// The subject is fixed per event type: it never carries prospect, company or task text.
const LABEL: Record<NotificationType, string> = {
  task_overdue: "Tarea vencida",
  task_due_soon: "Tarea por vencer",
  lead_assigned: "Lead asignado",
  opportunity_assigned: "Oportunidad asignada",
  sla_breached: "SLA incumplido",
  draft_pending_review: "Borrador pendiente de revisión",
};
const MAX_ATTEMPTS = 5;
const appUrl = () => (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

/**
 * E-mail copy of in-app notifications. Producing a notification only queues a job (inside the producer's transaction); the worker is the only
 * place that talks SMTP, using the organization's "notifications" account (never the outreach one).
 */
@Injectable()
export class NotificationEmailService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EmailSettingsService) private readonly settings: EmailSettingsService,
  ) {}

  /* ---------- admin API ---------- */

  get(auth: AuthContext): Promise<NotificationEmailDestinationsDto> {
    return this.db.withTenant(auth, (tx) => this.read(tx, auth.organizationId));
  }

  replace(auth: AuthContext, input: UpdateNotificationEmailDestinationsRequest): Promise<NotificationEmailDestinationsDto> {
    return this.db.withTenant(auth, async (tx) => {
      const org = auth.organizationId;
      const keep = new Set(input.addresses);
      await tx.notificationEmailDestination.deleteMany({ where: { organization_id: org, address: { notIn: [...keep] } } });
      const have = new Set((await tx.notificationEmailDestination.findMany({ where: { organization_id: org }, select: { address: true } })).map((d) => d.address));
      const fresh = input.addresses.filter((a) => !have.has(a));
      if (fresh.length > 0) await tx.notificationEmailDestination.createMany({ data: fresh.map((address) => ({ organization_id: org, address })) });
      if (input.enabledTypes) {
        const on = new Set(input.enabledTypes);
        for (const type of NOTIFICATION_TYPES) {
          await tx.notificationEmailRule.upsert({
            where: { organization_id_type: { organization_id: org, type } },
            create: { organization_id: org, type, enabled: on.has(type) },
            update: { enabled: on.has(type), updated_at: new Date() },
          });
        }
      }
      // Audit records how many addresses, never the addresses themselves.
      await this.audit.record(tx, auth, { action: "notification.email_destinations_updated", resourceType: "organization", resourceId: org, metadata: { count: input.addresses.length, typesChanged: input.enabledTypes !== undefined } });
      return this.read(tx, org);
    });
  }

  /** Queues one test message for a destination; the worker sends it. Answers 409 when there is no notifications account to send from. */
  testDestination(auth: AuthContext, destinationId: string): Promise<NotificationEmailTestQueuedDto> {
    return this.db.withTenant(auth, async (tx) => {
      const dest = await tx.notificationEmailDestination.findFirst({ where: { id: destinationId, organization_id: auth.organizationId }, select: { id: true } });
      if (!dest) throw new ApiException(404, "NOT_FOUND", "Destination not found");
      if (!(await tx.notificationSmtpSettings.findFirst({ where: { organization_id: auth.organizationId }, select: { organization_id: true } }))) {
        throw new ApiException(409, "CONFLICT", "Configure the notifications SMTP account first");
      }
      const res = await tx.job.createMany({
        data: [{ organization_id: auth.organizationId, type: "notifications.send_email", dedupe_key: `dest-test:${dest.id}:${Date.now()}`, payload: { kind: "test", destinationId: dest.id }, max_attempts: MAX_ATTEMPTS }],
        skipDuplicates: true,
      });
      return { queued: res.count === 1 };
    });
  }

  private async read(tx: Tx, organizationId: string): Promise<NotificationEmailDestinationsDto> {
    const [items, rules, account] = await Promise.all([
      tx.notificationEmailDestination.findMany({ where: { organization_id: organizationId }, orderBy: [{ created_at: "asc" }, { id: "asc" }] }),
      tx.notificationEmailRule.findMany({ where: { organization_id: organizationId }, select: { type: true, enabled: true } }),
      tx.notificationSmtpSettings.findFirst({ where: { organization_id: organizationId }, select: { organization_id: true } }),
    ]);
    const off = new Set(rules.filter((r) => !r.enabled).map((r) => r.type));
    return {
      max: MAX_NOTIFICATION_DESTINATIONS,
      items: items.map((d) => ({ id: d.id, address: d.address, lastTestAt: d.last_test_at?.toISOString() ?? null })),
      enabledTypes: NOTIFICATION_TYPES.filter((t) => !off.has(t)),
      accountConfigured: account !== null,
    };
  }

  /* ---------- producer side ---------- */

  /** Called by NotificationsService right after it created a notification, in the same transaction. Queues nothing when there is no destination or the type is off. */
  async queueInTx(tx: Tx, organizationId: string, notificationId: string, type: NotificationType): Promise<boolean> {
    if ((await tx.notificationEmailDestination.count({ where: { organization_id: organizationId } })) === 0) return false;
    const rule = await tx.notificationEmailRule.findFirst({ where: { organization_id: organizationId, type }, select: { enabled: true } });
    if (rule && !rule.enabled) return false;
    const res = await tx.job.createMany({
      data: [{ organization_id: organizationId, type: "notifications.send_email", dedupe_key: notificationId, payload: { kind: "notification", notificationId, type }, max_attempts: MAX_ATTEMPTS }],
      skipDuplicates: true,
    });
    return res.count === 1;
  }

  /* ---------- worker side ---------- */

  /**
   * Runs one `notifications.send_email` job. Throws (so the job retries with backoff and finally lands in the DLQ) when the notifications account
   * is missing or SMTP fails; the in-app notification already exists and is untouched either way. Delivery is at-least-once.
   */
  async sendJob(ctx: TenantContext, rawPayload: unknown): Promise<{ sent: number; skipped?: "type_disabled" | "no_destinations" }> {
    const payload = SendEmailPayload.parse(rawPayload);
    const loaded = await this.db.withTenant(ctx, async (tx) => {
      const destinations = await tx.notificationEmailDestination.findMany({
        where: { organization_id: ctx.organizationId, ...(payload.kind === "test" ? { id: payload.destinationId } : {}) },
        select: { id: true, address: true },
        orderBy: { id: "asc" },
      });
      if (destinations.length === 0) return { skipped: "no_destinations" as const };
      if (payload.kind === "notification") {
        const rule = await tx.notificationEmailRule.findFirst({ where: { organization_id: ctx.organizationId, type: payload.type }, select: { enabled: true } });
        if (rule && !rule.enabled) return { skipped: "type_disabled" as const };
      }
      const account = await this.settings.account(tx, ctx.organizationId, "notifications");
      if (!account) throw new ApiException(503, "UNAVAILABLE", "The notifications SMTP account is not configured");
      return { destinations, account };
    });
    if ("skipped" in loaded) return { sent: 0, skipped: loaded.skipped };

    const adapter = new SmtpEmailAdapter(loaded.account);
    const subject = payload.kind === "test" ? "Prueba de notificaciones por correo" : `Notificación: ${LABEL[payload.type]}`;
    const body = payload.kind === "test"
      ? "Este es un mensaje de prueba: las notificaciones de su organización llegarán a esta dirección."
      : `Tiene una notificación nueva (${LABEL[payload.type]}). Ábrala en la aplicación: ${appUrl()}/notifications\n\nMensaje automático; no responda.`;
    let sent = 0;
    let failure: string | null = null;
    for (const d of loaded.destinations) {
      try {
        await adapter.send({ idempotencyKey: `notif-email:${payload.kind === "test" ? `test:${d.id}:${Date.now()}` : `${payload.notificationId}:${d.id}`}`, to: d.address, subject, body });
        sent++;
      } catch (e) {
        failure = classifySmtpError(e);
      }
    }
    if (payload.kind === "test" && sent > 0) {
      await this.db.withTenant(ctx, (tx) => tx.notificationEmailDestination.updateMany({ where: { organization_id: ctx.organizationId, id: payload.destinationId }, data: { last_test_at: new Date() } }));
    }
    // Only the failure category is kept: the provider's text can echo addresses or credentials.
    if (failure) throw new ApiException(502, "UNAVAILABLE", `Notification e-mail delivery failed (${failure}); ${sent} of ${loaded.destinations.length} sent`);
    return { sent };
  }
}

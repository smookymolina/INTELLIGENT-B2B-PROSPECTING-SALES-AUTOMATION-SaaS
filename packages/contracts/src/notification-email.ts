import { z } from "zod";

/** Which SMTP account: "outreach" sends prospecting mail, "notifications" sends the app's own notifications to the configured destinations. */
export const EMAIL_PURPOSES = ["outreach", "notifications"] as const;
export const EmailPurpose = z.enum(EMAIL_PURPOSES);
export type EmailPurpose = z.infer<typeof EmailPurpose>;
export const EmailSettingsPurposeQuery = z.strictObject({ purpose: EmailPurpose.default("outreach") });
export type EmailSettingsPurposeQuery = z.infer<typeof EmailSettingsPurposeQuery>;

export const MAX_NOTIFICATION_DESTINATIONS = 5;
/** Same values as NOTIFICATION_TYPES (duplicated: importing index.ts from here would create an import cycle). */
const EMAILABLE_TYPES = ["task_overdue", "task_due_soon", "lead_assigned", "opportunity_assigned", "sla_breached", "draft_pending_review"] as const;
const destEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const NotificationEmailDestinationDto = z.object({ id: z.uuid(), address: z.string(), lastTestAt: z.iso.datetime().nullable() });
export type NotificationEmailDestinationDto = z.infer<typeof NotificationEmailDestinationDto>;
export const NotificationEmailDestinationsDto = z.object({
  max: z.literal(MAX_NOTIFICATION_DESTINATIONS),
  items: z.array(NotificationEmailDestinationDto),
  /** Event types that are also e-mailed (all by default). A type a user switched off in their own preferences is never e-mailed either. */
  enabledTypes: z.array(z.enum(EMAILABLE_TYPES)),
  /** Whether the "notifications" SMTP account is configured; without it queued e-mails wait and retry. */
  accountConfigured: z.boolean(),
});
export type NotificationEmailDestinationsDto = z.infer<typeof NotificationEmailDestinationsDto>;

/** PUT replaces the list (up to 5 distinct addresses) and, when given, the enabled event types. */
export const UpdateNotificationEmailDestinationsRequest = z.strictObject({
  addresses: z.array(destEmail).max(MAX_NOTIFICATION_DESTINATIONS).refine((a) => new Set(a).size === a.length, "addresses must be distinct"),
  enabledTypes: z.array(z.enum(EMAILABLE_TYPES)).max(EMAILABLE_TYPES.length).optional(),
});
export type UpdateNotificationEmailDestinationsRequest = z.infer<typeof UpdateNotificationEmailDestinationsRequest>;

/** The test message is queued and sent by the worker; the answer only says it was queued. */
export const NotificationEmailTestQueuedDto = z.object({ queued: z.boolean() });
export type NotificationEmailTestQueuedDto = z.infer<typeof NotificationEmailTestQueuedDto>;

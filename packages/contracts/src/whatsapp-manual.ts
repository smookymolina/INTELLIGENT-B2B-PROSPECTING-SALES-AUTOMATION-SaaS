import { z } from "zod";

/** WhatsApp manual: el SaaS nunca envia. Genera un enlace wa.me y la persona envia desde su propio numero; despues lo marca como enviado. */
export const WHATSAPP_LINKS_PER_HOUR_DEFAULT = 20;

export const WhatsAppLinkDto = z.object({
  draftId: z.uuid(),
  url: z.string().startsWith("https://wa.me/"),
  linksUsedThisHour: z.number().int().min(0),
  linksPerHour: z.number().int().min(1),
});
export type WhatsAppLinkDto = z.infer<typeof WhatsAppLinkDto>;

export const WhatsAppManualStatusDto = z.object({
  draftId: z.uuid(),
  state: z.enum(["none", "link_opened", "sent_manual"]),
  sentAt: z.iso.datetime().nullable(),
});
export type WhatsAppManualStatusDto = z.infer<typeof WhatsAppManualStatusDto>;

export const WhatsAppMarkSentDto = z.object({
  draftId: z.uuid(),
  state: z.literal("sent_manual"),
  sentAt: z.iso.datetime(),
  /** true cuando ya estaba registrado: la segunda llamada no duplica nada. */
  alreadyRecorded: z.boolean(),
});
export type WhatsAppMarkSentDto = z.infer<typeof WhatsAppMarkSentDto>;

/** Interfaz para enchufar mas adelante la Cloud API oficial de WhatsApp (no implementada): hoy solo existe el canal manual. */
export interface WhatsAppChannel {
  readonly name: "manual" | "cloud_api";
  /** manual: devuelve el enlace wa.me; nunca entrega por si mismo. */
  prepare(input: { phoneE164: string; body: string }): { kind: "link"; url: string } | { kind: "sent"; providerMessageId: string };
}

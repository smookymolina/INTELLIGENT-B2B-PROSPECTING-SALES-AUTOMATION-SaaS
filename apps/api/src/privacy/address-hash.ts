import { createHmac } from "node:crypto";

/**
 * Fingerprint of an erased address: HMAC-SHA256 keyed with a server pepper derived from HMAC_SECRET. The pepper never reaches the
 * database or the logs; only the resulting hash is passed (as a parameter) to the SECURITY DEFINER privacy functions.
 */
export function privacyPepper(hmacSecret: string | undefined = process.env.HMAC_SECRET): Buffer {
  if (!hmacSecret || hmacSecret.length < 32) throw new Error("HMAC_SECRET must be set to at least 32 characters");
  return createHmac("sha256", hmacSecret).update("privacy-erase-v1").digest();
}

/** Lowercase; for email also drop the `+tag` alias of the local part (the dot is provider-specific and is kept). WhatsApp is already E.164. */
export function normalizeAddress(channel: string, addressKey: string): string {
  const v = addressKey.trim().toLowerCase();
  if (channel !== "email") return v;
  const at = v.lastIndexOf("@");
  if (at <= 0) return v;
  const local = v.slice(0, at);
  const plus = local.indexOf("+");
  return `${plus > 0 ? local.slice(0, plus) : local}${v.slice(at)}`;
}

export function privacyAddressHash(organizationId: string, channel: string, addressKey: string, pepper: Buffer = privacyPepper()): string {
  return createHmac("sha256", pepper).update(`${organizationId}:${normalizeAddress(channel, addressKey)}`).digest("hex");
}

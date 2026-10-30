export const STATUS_LABELS: Record<string, string> = { draft: "Borrador", approved: "Aprobado", archived: "Archivado", superseded: "Reemplazada", active: "Activa", disabled: "Deshabilitada" };
export const KIND_LABELS: Record<string, string> = { product: "Producto", service: "Servicio" };
export const ROLE_LABELS: Record<string, string> = {
  org_admin: "Administrador", campaign_manager: "Gerente de campañas", sales_manager: "Gerente de ventas", seller: "Vendedor", analyst: "Analista", viewer: "Lector",
};

export const STAGE_LABELS: Record<string, string> = {
  new: "Nuevo", contacted: "Contactado", qualification: "Calificación", quote_requested: "Cotización solicitada", quote_sent: "Cotización enviada",
  negotiation: "Negociación", won: "Ganado", lost: "Perdido", future: "Futuro",
};

export const label = (map: Record<string, string>, key: string) => map[key] ?? key;

/** Only values we know are forwarded to the API; anything else in the URL is ignored. */
export function pick<T extends string>(value: string | string[] | undefined, allowed: readonly T[]): T | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return allowed.find((a) => a === v);
}
export const isCursor = (v: string | string[] | undefined): v is string => typeof v === "string" && /^[a-z0-9._-]{1,64}$/.test(v);

export const formatDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC" : "—");

export const OK: Record<string, string> = {
  created: "Elemento creado como borrador.",
  updated: "Cambios guardados.",
  draft: "Se creó un borrador nuevo a partir de la última versión.",
  approve: "Versión aprobada.",
  archive: "Elemento archivado.",
  restore: "Elemento restaurado.",
  category: "Categoría creada.",
  saved: "Guardado.",
};
export const ERR: Record<string, string> = {
  input: "Revisa los datos ingresados.",
  forbidden: "Tu rol no permite esta acción.",
  notfound: "No se encontró el elemento.",
  conflict: "El estado actual no permite esta acción (por ejemplo, no hay borrador abierto o el SKU ya existe).",
  expired: "Tu sesión expiró. Inicia sesión de nuevo.",
  rate: "Demasiadas solicitudes. Intenta en unos minutos.",
  toolarge: "El contenido es demasiado grande.",
  unavailable: "El servicio no está disponible. Intenta más tarde.",
  unexpected: "No fue posible completar la acción.",
};
export function notice(sp: { ok?: string; error?: string }): { kind: "ok" | "error"; text: string } | null {
  if (sp.error) return { kind: "error", text: ERR[sp.error] ?? (ERR.unexpected as string) };
  if (sp.ok && OK[sp.ok]) return { kind: "ok", text: OK[sp.ok] as string };
  return null;
}

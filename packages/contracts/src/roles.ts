import { z } from "zod";
import type { MembershipRole } from "./index.js";

/** Etiquetas de rol para la UI (decision del duenio: 3 roles visibles). org_admin = Gerente, seller = Usuario. */
export const ROLE_LABELS_ES: Readonly<Record<MembershipRole, string>> = {
  org_admin: "Gerente",
  campaign_manager: "Gestor de campañas",
  sales_manager: "Jefe de ventas",
  seller: "Usuario",
  analyst: "Analista",
  viewer: "Lector",
};

/** PUT /prospects/:id/owner and PUT /leads/:id/owner (org_admin only). */
export const SetOwnerRequest = z.strictObject({ ownerUserId: z.uuid() });
export type SetOwnerRequest = z.infer<typeof SetOwnerRequest>;
export const OwnerDto = z.strictObject({ id: z.uuid(), ownerUserId: z.uuid() });
export type OwnerDto = z.infer<typeof OwnerDto>;

/** Etiquetas de rol visibles para las personas: único lugar donde se traducen los roles de uso diario y el superadmin. */
export const ROLE_NAMES: Record<string, string> = { org_admin: "Gerente", seller: "Usuario", platform_admin: "Superadmin" };

export const roleName = (role: string): string => ROLE_NAMES[role] ?? role;

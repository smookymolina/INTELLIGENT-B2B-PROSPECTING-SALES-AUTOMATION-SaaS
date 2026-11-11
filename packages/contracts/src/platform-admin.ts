import { z } from "zod";

export const PLATFORM_ADMIN_RESOURCES = ["users", "prospects", "leads", "opportunities", "quotes", "campaigns"] as const;
export const PlatformAdminResourceParam = z.enum(PLATFORM_ADMIN_RESOURCES);
export type PlatformAdminResource = z.infer<typeof PlatformAdminResourceParam>;

/** Paginacion acotada: limite maximo 100 (tambien lo impone la funcion SQL). */
export const PlatformAdminPageQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type PlatformAdminPageQuery = z.infer<typeof PlatformAdminPageQuery>;

export const PlatformAdminOrganizationDto = z.object({
  id: z.uuid(), name: z.string(), slug: z.string(), status: z.string(), createdAt: z.iso.datetime(),
  counts: z.object({ users: z.number(), prospects: z.number(), leads: z.number(), opportunities: z.number(), quotes: z.number(), campaigns: z.number() }),
});
export type PlatformAdminOrganizationDto = z.infer<typeof PlatformAdminOrganizationDto>;
export type PlatformAdminOrganizationsDto = { total: number; limit: number; offset: number; items: PlatformAdminOrganizationDto[] };
export type PlatformAdminResourceDto = { total: number; limit: number; offset: number; items: Record<string, unknown>[] };

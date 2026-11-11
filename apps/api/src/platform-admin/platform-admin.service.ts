import { Inject, Injectable } from "@nestjs/common";
import type { PlatformAdminOrganizationsDto, PlatformAdminPageQuery, PlatformAdminResource, PlatformAdminResourceDto } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";

type OrgRow = { id: string; name: string; slug: string; status: string; created_at: Date; users: bigint; prospects: bigint; leads: bigint; opportunities: bigint; quotes: bigint; campaigns: bigint; total: bigint };

/** Solo lectura de plataforma. Todo pasa por funciones SECURITY DEFINER que exigen platform_admins y auditan; aqui no hay SQL de lectura directa. */
@Injectable()
export class PlatformAdminService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  async isPlatformAdmin(auth: AuthContext): Promise<boolean> {
    const rows = await this.db.withTenant(auth, (tx) => tx.$queryRaw<{ ok: boolean }[]>`SELECT platform_admin_is() AS ok`);
    return rows[0]?.ok === true;
  }

  organizations(auth: AuthContext, q: PlatformAdminPageQuery): Promise<PlatformAdminOrganizationsDto> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.$queryRaw<OrgRow[]>`SELECT * FROM platform_admin_organizations(${q.limit}::int, ${q.offset}::int, ${auth.requestId})`;
      return {
        total: Number(rows[0]?.total ?? 0), limit: q.limit, offset: q.offset,
        items: rows.map((r) => ({
          id: r.id, name: r.name, slug: r.slug, status: r.status, createdAt: r.created_at.toISOString(),
          counts: { users: Number(r.users), prospects: Number(r.prospects), leads: Number(r.leads), opportunities: Number(r.opportunities), quotes: Number(r.quotes), campaigns: Number(r.campaigns) },
        })),
      };
    });
  }

  async resource(auth: AuthContext, orgId: string, resource: PlatformAdminResource, q: PlatformAdminPageQuery): Promise<PlatformAdminResourceDto> {
    try {
      return await this.db.withTenant(auth, async (tx) => {
        const rows = await tx.$queryRaw<{ r: PlatformAdminResourceDto }[]>`SELECT platform_admin_resource(${orgId}::uuid, ${resource}, ${q.limit}::int, ${q.offset}::int, ${auth.requestId}) AS r`;
        return rows[0]!.r;
      });
    } catch (e) {
      if (String((e as Error).message).includes("organization_not_found")) throw new ApiException(404, "NOT_FOUND", "Organization not found");
      throw e;
    }
  }
}

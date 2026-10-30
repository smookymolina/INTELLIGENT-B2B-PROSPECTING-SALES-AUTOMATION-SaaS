import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { OrganizationDto, UpdateOrganizationRequest } from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService } from "../db/prisma.service.js";

const select = { id: true, name: true, slug: true } as const;

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  get(auth: AuthContext): Promise<OrganizationDto> {
    return this.db.withTenant(auth, async (tx) => {
      const org = await tx.organization.findFirst({ where: { id: auth.organizationId }, select });
      if (!org) throw new NotFoundException();
      return org;
    });
  }

  update(auth: AuthContext, input: UpdateOrganizationRequest): Promise<OrganizationDto> {
    return this.db.withTenant(auth, async (tx) => {
      const before = await tx.organization.findFirst({ where: { id: auth.organizationId }, select });
      if (!before) throw new NotFoundException();
      const org = await tx.organization.update({ where: { id: auth.organizationId }, data: { name: input.name }, select });
      await this.audit.record(tx, auth, {
        action: "organization.updated",
        resourceType: "organization",
        resourceId: org.id,
        metadata: { previousName: before.name, name: org.name },
      });
      return org;
    });
  }
}

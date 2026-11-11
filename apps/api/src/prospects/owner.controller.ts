import { Body, Controller, Inject, Injectable, NotFoundException, Param, Put, UnprocessableEntityException } from "@nestjs/common";
import { SetOwnerRequest, UuidParam, type OwnerDto } from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { PrismaService } from "../db/prisma.service.js";

const idPipe = () => new ZodPipe(UuidParam);

/** Reasignacion de propietario (solo Gerente = org_admin). La BD valida rol y que el nuevo propietario sea miembro activo. */
@Injectable()
export class OwnerService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService, @Inject(AuditService) private readonly audit: AuditService) {}

  prospect(auth: AuthContext, id: string, ownerUserId: string): Promise<OwnerDto> {
    return this.db.withTenant(auth, async (tx) => {
      const cur = await tx.prospect.findFirst({ where: { id, organization_id: auth.organizationId }, select: { owner_user_id: true } });
      if (!cur) throw new NotFoundException();
      await this.assertMember(tx, auth, ownerUserId);
      await tx.prospect.update({ where: { id }, data: { owner_user_id: ownerUserId } });
      // Los leads del prospecto siguen a su propietario.
      await tx.lead.updateMany({ where: { prospect_id: id, organization_id: auth.organizationId }, data: { owner_user_id: ownerUserId } });
      await this.audit.record(tx, auth, { action: "prospect.owner_changed", resourceType: "prospect", resourceId: id, metadata: { from: cur.owner_user_id, to: ownerUserId } });
      return { id, ownerUserId };
    });
  }

  lead(auth: AuthContext, id: string, ownerUserId: string): Promise<OwnerDto> {
    return this.db.withTenant(auth, async (tx) => {
      const cur = await tx.lead.findFirst({ where: { id, organization_id: auth.organizationId }, select: { owner_user_id: true } });
      if (!cur) throw new NotFoundException();
      await this.assertMember(tx, auth, ownerUserId);
      await tx.lead.update({ where: { id }, data: { owner_user_id: ownerUserId } });
      await this.audit.record(tx, auth, { action: "lead.owner_changed", resourceType: "lead", resourceId: id, metadata: { from: cur.owner_user_id, to: ownerUserId } });
      return { id, ownerUserId };
    });
  }

  private async assertMember(tx: Parameters<Parameters<PrismaService["withTenant"]>[1]>[0], auth: AuthContext, userId: string): Promise<void> {
    const m = await tx.membership.findFirst({ where: { organization_id: auth.organizationId, user_id: userId, status: "active", role: { in: ["org_admin", "sales_manager", "campaign_manager", "seller"] } }, select: { id: true } });
    if (!m) throw new UnprocessableEntityException("The owner must be an active member of this organization");
  }
}

@Controller()
export class OwnerController {
  constructor(@Inject(OwnerService) private readonly owners: OwnerService) {}

  @Put("prospects/:id/owner")
  @RequirePermission("members:manage")
  prospect(@Auth() auth: AuthContext, @Param("id", idPipe()) id: string, @Body(new ZodPipe(SetOwnerRequest)) body: SetOwnerRequest): Promise<OwnerDto> {
    return this.owners.prospect(auth, id, body.ownerUserId);
  }

  @Put("leads/:id/owner")
  @RequirePermission("members:manage")
  lead(@Auth() auth: AuthContext, @Param("id", idPipe()) id: string, @Body(new ZodPipe(SetOwnerRequest)) body: SetOwnerRequest): Promise<OwnerDto> {
    return this.owners.lead(auth, id, body.ownerUserId);
  }
}

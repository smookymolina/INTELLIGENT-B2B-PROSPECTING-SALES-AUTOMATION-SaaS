import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { MemberDto, UpdateMemberRequest } from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService, type Tx } from "../db/prisma.service.js";

const select = {
  id: true,
  role: true,
  status: true,
  user: { select: { id: true, email: true, display_name: true } },
} as const;

type Row = { id: string; role: MemberDto["role"]; status: MemberDto["status"]; user: { id: string; email: string; display_name: string } };

const toDto = (r: Row): MemberDto => ({
  id: r.id,
  role: r.role,
  status: r.status,
  user: { id: r.user.id, email: r.user.email, displayName: r.user.display_name },
});

@Injectable()
export class MembershipsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext): Promise<MemberDto[]> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.membership.findMany({ where: { organization_id: auth.organizationId }, select, orderBy: [{ created_at: "asc" }, { id: "asc" }] });
      return rows.map(toDto);
    });
  }

  updateRole(auth: AuthContext, id: string, input: UpdateMemberRequest): Promise<MemberDto> {
    return this.db.withTenant(auth, async (tx) => {
      await this.lockOrganization(tx, auth);
      const current = await this.find(tx, auth, id);
      if (current.role === "org_admin" && input.role !== "org_admin") await this.assertAnotherAdmin(tx, auth, id);
      const updated = await tx.membership.update({ where: { id }, data: { role: input.role }, select });
      await this.audit.record(tx, auth, {
        action: "membership.role_changed",
        resourceType: "membership",
        resourceId: id,
        metadata: { from: current.role, to: input.role, userId: current.user.id },
      });
      return toDto(updated);
    });
  }

  remove(auth: AuthContext, id: string): Promise<void> {
    return this.db.withTenant(auth, async (tx) => {
      await this.lockOrganization(tx, auth);
      const current = await this.find(tx, auth, id);
      if (current.role === "org_admin") await this.assertAnotherAdmin(tx, auth, id);
      await tx.membership.delete({ where: { id } });
      await this.audit.record(tx, auth, {
        action: "membership.removed",
        resourceType: "membership",
        resourceId: id,
        metadata: { role: current.role, userId: current.user.id },
      });
    });
  }

  private async find(tx: Tx, auth: AuthContext, id: string): Promise<Row> {
    const row = await tx.membership.findFirst({ where: { id, organization_id: auth.organizationId }, select });
    if (!row) throw new NotFoundException();
    return row;
  }

  /** Serializes membership changes per organization so two concurrent demotions cannot remove the last admin. */
  private async lockOrganization(tx: Tx, auth: AuthContext): Promise<void> {
    await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${auth.organizationId}::uuid FOR UPDATE`;
  }

  private async assertAnotherAdmin(tx: Tx, auth: AuthContext, excludingId: string): Promise<void> {
    const others = await tx.membership.count({
      where: { organization_id: auth.organizationId, role: "org_admin", status: "active", id: { not: excludingId } },
    });
    if (others === 0) throw new ConflictException("An organization must keep at least one active org_admin");
  }
}

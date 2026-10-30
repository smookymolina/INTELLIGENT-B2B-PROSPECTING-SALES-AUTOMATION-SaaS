import { Inject, Injectable } from "@nestjs/common";
import type { AuditEventDto } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService, type Prisma, type Tx } from "../db/prisma.service.js";

export type AuditEventInput = Readonly<{
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Prisma.InputJsonObject;
}>;

@Injectable()
export class AuditService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  /** Writes inside the caller's transaction so the audit row commits atomically with the sensitive change. */
  async record(tx: Tx, actor: Pick<AuthContext, "organizationId" | "userId" | "requestId">, event: AuditEventInput): Promise<void> {
    await tx.auditEvent.create({
      data: {
        organization_id: actor.organizationId,
        actor_user_id: actor.userId,
        action: event.action,
        resource_type: event.resourceType,
        resource_id: event.resourceId ?? null,
        metadata: event.metadata ?? {},
        request_id: actor.requestId,
      },
    });
  }

  list(auth: AuthContext, limit: number): Promise<AuditEventDto[]> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.auditEvent.findMany({
        where: { organization_id: auth.organizationId },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        take: limit,
      });
      return rows.map((r) => ({
        id: r.id,
        actorUserId: r.actor_user_id,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        metadata: r.metadata,
        createdAt: r.created_at.toISOString(),
      }));
    });
  }
}

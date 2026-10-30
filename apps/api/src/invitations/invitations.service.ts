import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { AcceptedInvitationDto, CreateInvitationRequest, InvitationCreatedDto, InvitationDto } from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { hashToken } from "../auth/tokens.js";
import { PrismaService } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PENDING_INVITATIONS = 100;

const select = { id: true, email: true, role: true, invited_by: true, expires_at: true, created_at: true } as const;
type Row = { id: string; email: string; role: InvitationDto["role"]; invited_by: string; expires_at: Date; created_at: Date };
const toDto = (r: Row): InvitationDto => ({
  id: r.id,
  email: r.email,
  role: r.role,
  invitedBy: r.invited_by,
  expiresAt: r.expires_at.toISOString(),
  createdAt: r.created_at.toISOString(),
});

type AcceptRow = { organization_id: string; organization_name: string; slug: string; role: AcceptedInvitationDto["role"]; membership_created: boolean };

/** Pending = not accepted, not revoked, not expired. */
const pending = () => ({ accepted_at: null, revoked_at: null, expires_at: { gt: new Date() } });

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Creates a pending offer. Never creates a membership and never checks whether the email belongs to a user
   * (the response is identical either way, so invitations cannot be used to enumerate accounts).
   */
  create(auth: AuthContext, input: CreateInvitationRequest): Promise<InvitationCreatedDto> {
    const token = randomBytes(32).toString("base64url");
    return this.db.withTenant(auth, async (tx) => {
      const open = await tx.invitation.count({ where: { organization_id: auth.organizationId, ...pending() } });
      if (open >= MAX_PENDING_INVITATIONS) throw new ApiException(409, "CONFLICT", "Too many pending invitations; revoke some first");

      // A newer offer to the same email supersedes older pending ones.
      const superseded = await tx.invitation.updateMany({
        where: { organization_id: auth.organizationId, email: input.email, ...pending() },
        data: { revoked_at: new Date() },
      });
      const row = await tx.invitation.create({
        data: {
          organization_id: auth.organizationId,
          email: input.email,
          role: input.role,
          token_hash: hashToken(token),
          invited_by: auth.userId,
          expires_at: new Date(Date.now() + INVITATION_TTL_MS),
        },
        select,
      });
      await this.audit.record(tx, auth, {
        action: "invitation.created",
        resourceType: "invitation",
        resourceId: row.id,
        metadata: { role: input.role, supersededCount: superseded.count },
      });
      return { ...toDto(row), token };
    });
  }

  list(auth: AuthContext): Promise<InvitationDto[]> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.invitation.findMany({
        where: { organization_id: auth.organizationId, ...pending() },
        select,
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        take: MAX_PENDING_INVITATIONS,
      });
      return rows.map(toDto);
    });
  }

  revoke(auth: AuthContext, id: string): Promise<void> {
    return this.db.withTenant(auth, async (tx) => {
      const result = await tx.invitation.updateMany({
        where: { id, organization_id: auth.organizationId, ...pending() },
        data: { revoked_at: new Date() },
      });
      if (result.count === 0) throw new ApiException(404, "NOT_FOUND", "Not Found");
      await this.audit.record(tx, auth, { action: "invitation.revoked", resourceType: "invitation", resourceId: id });
    });
  }

  /** Every failure mode yields the same 404 (unknown, expired, used, revoked, wrong email, inactive org). */
  async accept(auth: AuthContext, token: string): Promise<AcceptedInvitationDto> {
    const rows = await this.db.withoutTenant(
      (tx) => tx.$queryRaw<AcceptRow[]>`SELECT * FROM invitation_accept(${hashToken(token)}, ${auth.userId}::uuid, ${auth.requestId})`,
    );
    const row = rows[0];
    if (!row) throw new ApiException(404, "NOT_FOUND", "Invitation not found or no longer valid");
    return {
      organization: { id: row.organization_id, name: row.organization_name, slug: row.slug },
      role: row.role,
      membershipCreated: row.membership_created,
    };
  }
}

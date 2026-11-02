import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { MergeProspectRequest, ProspectMergeDto, ProspectMergeListDto } from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";

const conflict = (message: string) => new ApiException(409, "CONFLICT", message, null);
/** The database guard (trigger) is the authority; its messages are mapped to 409 instead of leaking as 500. */
const mapGuard = (e: unknown): never => {
  const m = String((e as { message?: string }).message ?? "");
  // `unique_violation` from the guard surfaces as Prisma P2002 without the trigger text; it can only mean "already merged" on this table.
  if (m.includes("already merged") || (e as { code?: string }).code === "P2002") throw conflict("This prospect is already merged into another one");
  if (m.includes("merge chains")) throw conflict("Merge chains are not allowed: unmerge first");
  if (m.includes("already reverted")) throw conflict("The merge was already reverted");
  throw e;
};

type MergeRow = { id: string; survivor_id: string; duplicate_id: string; reason: string; merged_by: string; merged_at: Date; reverted_by: string | null; reverted_at: Date | null };
const toDto = (r: MergeRow): ProspectMergeDto => ({
  id: r.id, survivorId: r.survivor_id, duplicateId: r.duplicate_id, reason: r.reason, mergedBy: r.merged_by, mergedAt: r.merged_at.toISOString(),
  revertedBy: r.reverted_by, revertedAt: r.reverted_at?.toISOString() ?? null,
});

/**
 * Reversible duplicate merge. A duplicate is hidden behind its survivor (lists and exports skip it); no child row is moved or deleted,
 * so suppression, consent, provenance, leads and contacts keep working exactly as before and the merge can be undone without loss.
 */
@Injectable()
export class ProspectMergeService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  merge(auth: AuthContext, survivorId: string, input: MergeProspectRequest): Promise<ProspectMergeDto> {
    if (input.duplicateId === survivorId) throw new ApiException(400, "VALIDATION_FAILED", "A prospect cannot be merged into itself", { issues: [{ path: "duplicateId", code: "custom" }] });
    return this.db
      .withTenant(auth, async (tx) => {
        const found = await tx.prospect.findMany({ where: { organization_id: auth.organizationId, id: { in: [survivorId, input.duplicateId] } }, select: { id: true } });
        if (found.length !== 2) throw new NotFoundException();
        const row = await tx.prospectMerge.create({
          data: { organization_id: auth.organizationId, survivor_id: survivorId, duplicate_id: input.duplicateId, reason: input.reason, merged_by: auth.userId },
        });
        await this.audit.record(tx, auth, { action: "prospect.merged", resourceType: "prospect", resourceId: survivorId, metadata: { mergeId: row.id, duplicateId: input.duplicateId } });
        return toDto(row);
      })
      .catch(mapGuard);
  }

  list(auth: AuthContext, prospectId: string): Promise<ProspectMergeListDto> {
    return this.db.withTenant(auth, async (tx) => {
      if (!(await tx.prospect.findFirst({ where: { id: prospectId, organization_id: auth.organizationId }, select: { id: true } }))) throw new NotFoundException();
      const rows = await tx.prospectMerge.findMany({
        where: { organization_id: auth.organizationId, OR: [{ survivor_id: prospectId }, { duplicate_id: prospectId }] },
        orderBy: [{ merged_at: "desc" }, { id: "asc" }],
        take: 200,
      });
      return { items: rows.map(toDto) };
    });
  }

  revert(auth: AuthContext, survivorId: string, mergeId: string): Promise<ProspectMergeDto> {
    return this.db
      .withTenant(auth, async (tx) => {
        const current = await tx.prospectMerge.findFirst({ where: { id: mergeId, survivor_id: survivorId, organization_id: auth.organizationId } });
        if (!current) throw new NotFoundException();
        if (current.reverted_at) throw conflict("The merge was already reverted");
        const row = await tx.prospectMerge.update({ where: { id: mergeId }, data: { reverted_by: auth.userId, reverted_at: new Date() } });
        await this.audit.record(tx, auth, { action: "prospect.merge_reverted", resourceType: "prospect", resourceId: survivorId, metadata: { mergeId, duplicateId: row.duplicate_id } });
        return toDto(row);
      })
      .catch(mapGuard);
  }
}

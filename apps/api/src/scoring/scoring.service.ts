import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AttributeDecisionRequest,
  AttributeDto,
  AttributeListDto,
  CreateAttributeRequest,
  ProspectScoreDto,
  RecomputeDto,
  SaveScoringDraftRequest,
  ScoreBreakdownDto,
  ScoreResultDto,
  ScoreRule,
  ScoringModelDto,
  ScoringVersionDto,
} from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService, type Prisma, type Tx } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";
import { ProspectsService } from "../prospects/prospects.service.js";
import { evaluate } from "./engine.js";

const conflict = (message: string) => new ApiException(409, "CONFLICT", message);
const isUnique = (e: unknown) => (e as { code?: string }).code === "P2002" || String((e as { message?: string }).message ?? "").includes("open draft");
const MAX_RECOMPUTE = 1000;

type AttrRow = {
  id: string; key: string; value: string; confidence: string; source: string; status: string; created_at: Date; decided_at: Date | null;
};
const attributeDto = (r: AttrRow, conflicting: boolean): AttributeDto => ({
  id: r.id, key: r.key, value: r.value, confidence: r.confidence as AttributeDto["confidence"], source: r.source as AttributeDto["source"],
  status: r.status as AttributeDto["status"], conflict: conflicting && r.status !== "rejected", createdAt: r.created_at.toISOString(), decidedAt: r.decided_at?.toISOString() ?? null,
});
const conflictingKeys = (rows: AttrRow[]): Set<string> => {
  const live = new Map<string, Set<string>>();
  for (const r of rows) if (r.status !== "rejected") live.set(r.key, (live.get(r.key) ?? new Set()).add(r.value.trim().toLowerCase()));
  return new Set([...live].filter(([, values]) => values.size > 1).map(([key]) => key));
};

type VersionRow = { id: string; version: number; state: string; rules: Prisma.JsonValue; created_at: Date; approved_at: Date | null };
const versionDto = (v: VersionRow): ScoringVersionDto => ({
  id: v.id, version: v.version, state: v.state as ScoringVersionDto["state"], rules: v.rules as unknown as ScoreRule[], createdAt: v.created_at.toISOString(), approvedAt: v.approved_at?.toISOString() ?? null,
});
const resultDto = (r: { id: string; prospect_id: string; total: number; breakdown: Prisma.JsonValue; computed_at: Date }, modelVersion: number): ScoreResultDto => ({
  id: r.id, prospectId: r.prospect_id, modelVersion, total: r.total, breakdown: r.breakdown as unknown as ScoreBreakdownDto[], computedAt: r.computed_at.toISOString(),
});

/** Enrichment attributes (with provenance and human verification) and the rule-based, versioned, explainable scoring model. */
@Injectable()
export class ScoringService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ProspectsService) private readonly prospects: ProspectsService,
  ) {}

  /* ---------- attributes ---------- */

  listAttributes(auth: AuthContext, prospectId: string): Promise<AttributeListDto> {
    return this.db.withTenant(auth, async (tx) => {
      await this.assertProspect(tx, auth, prospectId);
      const rows = await tx.prospectAttribute.findMany({ where: { organization_id: auth.organizationId, prospect_id: prospectId }, orderBy: [{ key: "asc" }, { created_at: "asc" }, { id: "asc" }] });
      const bad = conflictingKeys(rows);
      return { items: rows.map((r) => attributeDto(r, bad.has(r.key))) };
    });
  }

  async addAttribute(auth: AuthContext, prospectId: string, input: CreateAttributeRequest): Promise<AttributeDto> {
    try {
      return await this.db.withTenant(auth, async (tx) => {
        await this.assertProspect(tx, auth, prospectId);
        const row = await tx.prospectAttribute.create({
          data: {
            organization_id: auth.organizationId, prospect_id: prospectId, key: input.key, value: input.value, value_key: input.value.trim().toLowerCase(),
            confidence: input.confidence, source: "manual", created_by: auth.userId,
          },
        });
        // Audit records which attribute was added, never its value.
        await this.audit.record(tx, auth, { action: "prospect.attribute_added", resourceType: "prospect", resourceId: prospectId, metadata: { key: input.key, attributeId: row.id } });
        const all = await tx.prospectAttribute.findMany({ where: { organization_id: auth.organizationId, prospect_id: prospectId, key: input.key } });
        return attributeDto(row, conflictingKeys(all).has(input.key));
      });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw conflict("That value is already recorded for this attribute");
      throw e;
    }
  }

  decideAttribute(auth: AuthContext, prospectId: string, attributeId: string, input: AttributeDecisionRequest): Promise<AttributeDto> {
    return this.db.withTenant(auth, async (tx) => {
      const target = await tx.prospectAttribute.findFirst({ where: { id: attributeId, prospect_id: prospectId, organization_id: auth.organizationId } });
      if (!target) throw new NotFoundException();
      const decided = { decided_by: auth.userId, decided_at: new Date() };
      if (input.decision === "verify") {
        // A human choosing one value resolves the conflict: the other live values of the key are rejected (kept, never deleted).
        await tx.prospectAttribute.updateMany({
          where: { organization_id: auth.organizationId, prospect_id: prospectId, key: target.key, id: { not: target.id }, status: { not: "rejected" } },
          data: { status: "rejected", ...decided },
        });
        await tx.prospectAttribute.update({ where: { id: target.id }, data: { status: "verified", ...decided } });
      } else {
        await tx.prospectAttribute.update({ where: { id: target.id }, data: { status: "rejected", ...decided } });
      }
      await this.audit.record(tx, auth, {
        action: input.decision === "verify" ? "prospect.attribute_verified" : "prospect.attribute_rejected", resourceType: "prospect", resourceId: prospectId,
        metadata: { key: target.key, attributeId },
      });
      const all = await tx.prospectAttribute.findMany({ where: { organization_id: auth.organizationId, prospect_id: prospectId, key: target.key } });
      const fresh = all.find((a) => a.id === target.id) as AttrRow;
      return attributeDto(fresh, conflictingKeys(all).has(target.key));
    });
  }

  /* ---------- model ---------- */

  getModel(auth: AuthContext): Promise<ScoringModelDto> {
    return this.db.withTenant(auth, (tx) => this.loadModel(tx, auth));
  }

  async saveDraft(auth: AuthContext, input: SaveScoringDraftRequest): Promise<ScoringModelDto> {
    try {
      return await this.db.withTenant(auth, async (tx) => {
        const draft = await tx.scoringModelVersion.findFirst({ where: { organization_id: auth.organizationId, state: "draft" } });
        if (draft) {
          await tx.scoringModelVersion.update({ where: { id: draft.id }, data: { rules: input.rules as unknown as Prisma.InputJsonValue } });
        } else {
          const latest = await tx.scoringModelVersion.aggregate({ where: { organization_id: auth.organizationId }, _max: { version: true } });
          await tx.scoringModelVersion.create({
            data: { organization_id: auth.organizationId, version: (latest._max.version ?? 0) + 1, state: "draft", rules: input.rules as unknown as Prisma.InputJsonValue, created_by: auth.userId },
          });
        }
        await this.audit.record(tx, auth, { action: "scoring.draft_saved", resourceType: "scoring_model", metadata: { rules: input.rules.length } });
        return this.loadModel(tx, auth);
      });
    } catch (e) {
      throw isUnique(e) ? conflict("The scoring model changed concurrently; retry") : e;
    }
  }

  approveModel(auth: AuthContext): Promise<ScoringModelDto> {
    return this.db.withTenant(auth, async (tx) => {
      const draft = await tx.scoringModelVersion.findFirst({ where: { organization_id: auth.organizationId, state: "draft" } });
      if (!draft) throw conflict("There is no draft to approve");
      if ((draft.rules as unknown as ScoreRule[]).length === 0) throw conflict("A scoring model needs at least one rule");
      await tx.scoringModelVersion.updateMany({ where: { organization_id: auth.organizationId, state: "approved" }, data: { state: "superseded" } });
      await tx.scoringModelVersion.update({ where: { id: draft.id }, data: { state: "approved", approved_by: auth.userId, approved_at: new Date() } });
      await this.audit.record(tx, auth, { action: "scoring.model_approved", resourceType: "scoring_model", resourceId: draft.id, metadata: { version: draft.version } });
      return this.loadModel(tx, auth);
    });
  }

  /* ---------- scores ---------- */

  getScore(auth: AuthContext, prospectId: string): Promise<ProspectScoreDto> {
    return this.db.withTenant(auth, async (tx) => {
      await this.assertProspect(tx, auth, prospectId);
      const latest = await tx.scoreResult.findFirst({ where: { organization_id: auth.organizationId, prospect_id: prospectId }, orderBy: [{ computed_at: "desc" }, { id: "desc" }], include: { model: { select: { version: true } } } });
      if (!latest) return { result: null, stale: false };
      const approved = await tx.scoringModelVersion.findFirst({ where: { organization_id: auth.organizationId, state: "approved" }, select: { id: true } });
      return { result: resultDto(latest, latest.model.version), stale: approved?.id !== latest.model_version_id };
    });
  }

  scoreProspect(auth: AuthContext, prospectId: string): Promise<ScoreResultDto> {
    return this.db.withTenant(auth, async (tx) => {
      const model = await this.requireApproved(tx, auth);
      return (await this.scoreOne(tx, auth, prospectId, model)).dto;
    });
  }

  recomputeAll(auth: AuthContext): Promise<RecomputeDto> {
    return this.db.withTenant(
      auth,
      async (tx) => {
        const model = await this.requireApproved(tx, auth);
        const sets = await this.prospects.suppressionSets(tx, auth);
        const rows = await tx.prospect.findMany({ where: { organization_id: auth.organizationId }, orderBy: { id: "asc" }, take: MAX_RECOMPUTE });
        let computed = 0;
        let skipped = 0;
        for (const p of rows) {
          if ((p.domain_key !== null && sets.domains.has(p.domain_key)) || sets.names.has(p.name_key)) {
            skipped++;
            continue;
          }
          await this.scoreOne(tx, auth, p.id, model);
          computed++;
        }
        await this.audit.record(tx, auth, { action: "scoring.recomputed", resourceType: "scoring_model", resourceId: model.id, metadata: { computed, skipped, version: model.version } });
        return { computed, skippedSuppressed: skipped, modelVersion: model.version };
      },
      { timeoutMs: 120_000 },
    );
  }

  /* ---------- helpers ---------- */

  private async scoreOne(tx: Tx, auth: AuthContext, prospectId: string, model: { id: string; version: number; rules: Prisma.JsonValue }) {
    const prospect = await tx.prospect.findFirst({ where: { id: prospectId, organization_id: auth.organizationId } });
    if (!prospect) throw new NotFoundException();
    const attributes = await tx.prospectAttribute.findMany({ where: { organization_id: auth.organizationId, prospect_id: prospectId }, select: { id: true, key: true, value: true, status: true } });
    const { total, breakdown } = evaluate(model.rules as unknown as ScoreRule[], {
      prospect: { country: prospect.country, industry: prospect.industry, city: prospect.city, region: prospect.region, status: prospect.status, domain: prospect.domain_key },
      attributes,
    });
    const row = await tx.scoreResult.create({
      data: { organization_id: auth.organizationId, prospect_id: prospectId, model_version_id: model.id, total, breakdown: breakdown as unknown as Prisma.InputJsonValue, computed_by: auth.userId },
    });
    return { row, dto: resultDto(row, model.version) };
  }

  private async requireApproved(tx: Tx, auth: AuthContext) {
    const model = await tx.scoringModelVersion.findFirst({ where: { organization_id: auth.organizationId, state: "approved" } });
    if (!model) throw conflict("There is no approved scoring model; an administrator must approve one first");
    return model;
  }

  private async loadModel(tx: Tx, auth: AuthContext): Promise<ScoringModelDto> {
    const rows = await tx.scoringModelVersion.findMany({ where: { organization_id: auth.organizationId, state: { in: ["draft", "approved"] } } });
    const find = (state: string) => rows.find((r) => r.state === state);
    const approved = find("approved");
    const draft = find("draft");
    return { approved: approved ? versionDto(approved) : null, draft: draft ? versionDto(draft) : null };
  }

  private async assertProspect(tx: Tx, auth: AuthContext, id: string): Promise<void> {
    if (!(await tx.prospect.findFirst({ where: { id, organization_id: auth.organizationId }, select: { id: true } }))) throw new NotFoundException();
  }
}

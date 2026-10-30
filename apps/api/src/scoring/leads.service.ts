import { createHash } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AssessReplyRequest,
  EvaluateLeadsDto,
  IntentAssessmentDto,
  IntentAssessmentListDto,
  LeadDecisionRequest,
  LeadDto,
  LeadListQuery,
  LeadPageDto,
  LeadSettingsDto,
  SetLeadSettingsRequest,
} from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService, type Prisma, type Tx } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";
import { ProspectsService } from "../prospects/prospects.service.js";
import { classify } from "./classifier.js";

const conflict = (message: string) => new ApiException(409, "CONFLICT", message);
const POSITIVE_FOR_LEAD = new Set(["purchase", "quote", "call", "info"]);
const MAX_EVALUATE = 1000;
const EXCERPT_CHARS = 500;
const lockKey = (scope: string) => `leads:${scope}`;

type LeadRow = {
  id: string; prospect_id: string; origin: string; state: string; min_score: number | null; score_result_id: string | null; assessment_id: string | null;
  review_note: string | null; reviewed_at: Date | null; created_at: Date;
};

/** Leads exist only through an explicit rule (score >= configured threshold, qualified, not suppressed) or a positively classified reply; humans review them. */
@Injectable()
export class LeadsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ProspectsService) private readonly prospects: ProspectsService,
  ) {}

  /* ---------- settings ---------- */

  getSettings(auth: AuthContext): Promise<LeadSettingsDto> {
    return this.db.withTenant(auth, async (tx) => ({ minScore: (await tx.leadSettings.findUnique({ where: { organization_id: auth.organizationId } }))?.min_score ?? null }));
  }

  setSettings(auth: AuthContext, input: SetLeadSettingsRequest): Promise<LeadSettingsDto> {
    return this.db.withTenant(auth, async (tx) => {
      const existing = await tx.leadSettings.findUnique({ where: { organization_id: auth.organizationId } });
      if (existing) await tx.leadSettings.update({ where: { organization_id: auth.organizationId }, data: { min_score: input.minScore, updated_by: auth.userId } });
      else await tx.leadSettings.create({ data: { organization_id: auth.organizationId, min_score: input.minScore, updated_by: auth.userId } });
      await this.audit.record(tx, auth, { action: "leads.settings_changed", resourceType: "lead_settings", metadata: { from: existing?.min_score ?? null, to: input.minScore } });
      return { minScore: input.minScore };
    });
  }

  /* ---------- rule-based creation ---------- */

  evaluate(auth: AuthContext): Promise<EvaluateLeadsDto> {
    return this.db.withTenant(
      auth,
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(`eval:${auth.organizationId}`)}, 0))`; // two evaluations never interleave
        const settings = await tx.leadSettings.findUnique({ where: { organization_id: auth.organizationId } });
        if (!settings) throw conflict("An administrator must set the minimum score before leads can be created by rule");
        const model = await tx.scoringModelVersion.findFirst({ where: { organization_id: auth.organizationId, state: "approved" } });
        if (!model) throw conflict("There is no approved scoring model");

        const sets = await this.prospects.suppressionSets(tx, auth);
        const qualified = await tx.prospect.findMany({ where: { organization_id: auth.organizationId, status: "qualified" }, orderBy: { id: "asc" }, take: MAX_EVALUATE });
        const ids = qualified.map((p) => p.id);
        const results = ids.length
          ? await tx.scoreResult.findMany({ where: { organization_id: auth.organizationId, prospect_id: { in: ids }, model_version_id: model.id }, orderBy: [{ computed_at: "desc" }, { id: "desc" }] })
          : [];
        const latest = new Map<string, (typeof results)[number]>();
        for (const r of results) if (!latest.has(r.prospect_id)) latest.set(r.prospect_id, r);
        const open = new Set(
          (await tx.lead.findMany({ where: { organization_id: auth.organizationId, prospect_id: { in: ids }, state: { in: ["pending_review", "accepted"] } }, select: { prospect_id: true } })).map((l) => l.prospect_id),
        );
        const rejectedFor = new Set(
          (await tx.lead.findMany({ where: { organization_id: auth.organizationId, state: "rejected", origin: "rule", score_result_id: { in: [...latest.values()].map((r) => r.id) } }, select: { score_result_id: true } })).map((l) => l.score_result_id),
        );

        const out: EvaluateLeadsDto = { created: 0, alreadyOpen: 0, belowThreshold: 0, noScore: 0, suppressed: 0, previouslyRejected: 0 };
        for (const p of qualified) {
          const score = latest.get(p.id);
          if ((p.domain_key !== null && sets.domains.has(p.domain_key)) || sets.names.has(p.name_key)) out.suppressed++;
          else if (open.has(p.id)) out.alreadyOpen++;
          else if (!score) out.noScore++;
          else if (score.total < settings.min_score) out.belowThreshold++;
          else if (rejectedFor.has(score.id)) out.previouslyRejected++; // a rejected lead is not re-created from the same evidence
          else {
            const lead = await tx.lead.create({
              data: { organization_id: auth.organizationId, prospect_id: p.id, origin: "rule", open_key: p.id, score_result_id: score.id, min_score: settings.min_score, created_by: auth.userId },
            });
            await this.audit.record(tx, auth, { action: "lead.created", resourceType: "lead", resourceId: lead.id, metadata: { origin: "rule", score: score.total, minScore: settings.min_score } });
            out.created++;
          }
        }
        return out;
      },
      { timeoutMs: 120_000 },
    );
  }

  /* ---------- listing and review ---------- */

  list(auth: AuthContext, q: LeadListQuery): Promise<LeadPageDto> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.lead.findMany({
        where: { organization_id: auth.organizationId, ...(q.state !== "all" ? { state: q.state } : {}), ...(q.cursor ? { id: { gt: q.cursor } } : {}) },
        orderBy: { id: "asc" },
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      return { items: await this.toDtos(tx, auth, page), nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
    });
  }

  get(auth: AuthContext, id: string): Promise<LeadDto> {
    return this.db.withTenant(auth, async (tx) => {
      const row = await tx.lead.findFirst({ where: { id, organization_id: auth.organizationId } });
      if (!row) throw new NotFoundException();
      return (await this.toDtos(tx, auth, [row]))[0] as LeadDto;
    });
  }

  decide(auth: AuthContext, id: string, input: LeadDecisionRequest): Promise<LeadDto> {
    return this.db.withTenant(auth, async (tx) => {
      const lead = await tx.lead.findFirst({ where: { id, organization_id: auth.organizationId } });
      if (!lead) throw new NotFoundException();
      if (lead.state !== "pending_review") throw conflict("Only pending leads can be reviewed");
      try {
        await tx.lead.update({
          where: { id },
          data: {
            state: input.decision === "accept" ? "accepted" : "rejected",
            ...(input.decision === "reject" ? { open_key: null } : {}),
            review_note: input.note ?? null, reviewed_by: auth.userId, reviewed_at: new Date(),
          },
        });
      } catch (e) {
        if (String((e as { message?: string }).message ?? "").includes("suppressed prospect")) throw conflict("The prospect is on the do-not-contact list");
        throw e;
      }
      await this.audit.record(tx, auth, { action: input.decision === "accept" ? "lead.accepted" : "lead.rejected", resourceType: "lead", resourceId: id });
      const fresh = await tx.lead.findFirstOrThrow({ where: { id } });
      return (await this.toDtos(tx, auth, [fresh]))[0] as LeadDto;
    });
  }

  /* ---------- replies / intent ---------- */

  assessReply(auth: AuthContext, prospectId: string, input: AssessReplyRequest): Promise<IntentAssessmentDto> {
    return this.db.withTenant(auth, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(`prospect:${prospectId}`)}, 0))`;
      const prospect = await tx.prospect.findFirst({ where: { id: prospectId, organization_id: auth.organizationId } });
      if (!prospect) throw new NotFoundException();
      const result = classify(input.text);
      const row = await tx.intentAssessment.create({
        data: {
          organization_id: auth.organizationId, prospect_id: prospectId, excerpt: input.text.replace(/\s+/g, " ").slice(0, EXCERPT_CHARS),
          text_hash: createHash("sha256").update(input.text, "utf8").digest("hex"), classifier_version: result.version, class: result.class,
          matched: result.matched as unknown as Prisma.InputJsonValue, ambiguous: result.ambiguous, created_by: auth.userId,
        },
      });
      await this.audit.record(tx, auth, { action: "reply.assessed", resourceType: "prospect", resourceId: prospectId, metadata: { assessmentId: row.id, class: result.class, ambiguous: result.ambiguous } });

      let suppressionCreated = false;
      let leadId: string | null = null;
      if (result.class === "unsubscribe") {
        // A removal request prevails over everything: the prospect goes on the do-not-contact list now (domain when known, else name).
        const kind = prospect.domain_key ? "domain" : "name";
        const valueKey = prospect.domain_key ?? prospect.name_key;
        const exists = await tx.suppression.findFirst({ where: { organization_id: auth.organizationId, kind, value_key: valueKey }, select: { id: true } });
        if (!exists) {
          const s = await tx.suppression.create({ data: { organization_id: auth.organizationId, kind, value_key: valueKey, reason: "unsubscribe request in a reply", created_by: auth.userId } });
          await this.audit.record(tx, auth, { action: "suppression.created", resourceType: "suppression", resourceId: s.id, metadata: { kind, via: "reply", assessmentId: row.id } });
          suppressionCreated = true;
        }
      } else if (POSITIVE_FOR_LEAD.has(result.class) && !result.ambiguous) {
        const sets = await this.prospects.suppressionSets(tx, auth);
        const suppressed = (prospect.domain_key !== null && sets.domains.has(prospect.domain_key)) || sets.names.has(prospect.name_key);
        const open = await tx.lead.findFirst({ where: { organization_id: auth.organizationId, prospect_id: prospectId, state: { in: ["pending_review", "accepted"] } }, select: { id: true } });
        if (!suppressed && !open) {
          const lead = await tx.lead.create({ data: { organization_id: auth.organizationId, prospect_id: prospectId, origin: "intent", open_key: prospectId, assessment_id: row.id, created_by: auth.userId } });
          await this.audit.record(tx, auth, { action: "lead.created", resourceType: "lead", resourceId: lead.id, metadata: { origin: "intent", class: result.class } });
          leadId = lead.id;
        }
      }
      return this.assessmentDto(row, { suppressionCreated, leadId });
    });
  }

  listAssessments(auth: AuthContext, prospectId: string): Promise<IntentAssessmentListDto> {
    return this.db.withTenant(auth, async (tx) => {
      if (!(await tx.prospect.findFirst({ where: { id: prospectId, organization_id: auth.organizationId }, select: { id: true } }))) throw new NotFoundException();
      const rows = await tx.intentAssessment.findMany({ where: { organization_id: auth.organizationId, prospect_id: prospectId }, orderBy: [{ created_at: "desc" }, { id: "desc" }], take: 100 });
      const leads = rows.length ? await tx.lead.findMany({ where: { organization_id: auth.organizationId, assessment_id: { in: rows.map((r) => r.id) } }, select: { id: true, assessment_id: true } }) : [];
      return { items: rows.map((r) => this.assessmentDto(r, { suppressionCreated: r.class === "unsubscribe", leadId: leads.find((l) => l.assessment_id === r.id)?.id ?? null })) };
    });
  }

  /* ---------- helpers ---------- */

  private assessmentDto(
    r: { id: string; prospect_id: string; class: string; ambiguous: boolean; matched: Prisma.JsonValue; classifier_version: string; excerpt: string; created_at: Date },
    effects: IntentAssessmentDto["effects"],
  ): IntentAssessmentDto {
    return {
      id: r.id, prospectId: r.prospect_id, class: r.class as IntentAssessmentDto["class"], ambiguous: r.ambiguous, matched: r.matched as IntentAssessmentDto["matched"],
      classifierVersion: r.classifier_version, excerpt: r.excerpt, createdAt: r.created_at.toISOString(), effects,
    };
  }

  private async toDtos(tx: Tx, auth: AuthContext, rows: LeadRow[]): Promise<LeadDto[]> {
    const [prospects, scores, assessments] = await Promise.all([
      tx.prospect.findMany({ where: { organization_id: auth.organizationId, id: { in: rows.map((r) => r.prospect_id) } }, select: { id: true, name: true, domain_key: true } }),
      tx.scoreResult.findMany({ where: { organization_id: auth.organizationId, id: { in: rows.flatMap((r) => (r.score_result_id ? [r.score_result_id] : [])) } }, select: { id: true, total: true } }),
      tx.intentAssessment.findMany({ where: { organization_id: auth.organizationId, id: { in: rows.flatMap((r) => (r.assessment_id ? [r.assessment_id] : [])) } }, select: { id: true, class: true } }),
    ]);
    return rows.map((r) => {
      const p = prospects.find((x) => x.id === r.prospect_id);
      return {
        id: r.id, prospect: { id: r.prospect_id, name: p?.name ?? "", domain: p?.domain_key ?? null }, origin: r.origin as LeadDto["origin"], state: r.state as LeadDto["state"],
        minScore: r.min_score, scoreTotal: scores.find((s) => s.id === r.score_result_id)?.total ?? null, intentClass: assessments.find((a) => a.id === r.assessment_id)?.class ?? null,
        reviewNote: r.review_note, reviewedAt: r.reviewed_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(),
      };
    });
  }
}

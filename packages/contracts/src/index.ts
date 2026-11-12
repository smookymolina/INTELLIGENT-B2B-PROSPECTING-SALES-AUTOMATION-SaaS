import { z } from "zod";
export * from "./discovery.js";

/** Shared contracts (API v1). Request schemas are strict: unknown keys (e.g. `organization_id`) are rejected, never trusted. */
export type HealthStatus = Readonly<{
  status: "ok";
  service: "api";
}>;

/* ---------- RBAC ---------- */

export const MEMBERSHIP_ROLES = ["org_admin", "campaign_manager", "sales_manager", "seller", "analyst", "viewer"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const PERMISSIONS = ["organization:read", "organization:update", "members:read", "members:manage", "audit:read", "catalog:read", "catalog:manage", "catalog:approve", "prospects:read", "prospects:manage", "suppressions:manage", "suppressions:remove", "scoring:manage", "scoring:approve", "leads:read", "leads:review", "crm:read", "crm:work", "crm:manage", "quotes:read", "quotes:manage", "quotes:approve", "analytics:read", "ai:use", "ai:manage", "campaigns:read", "campaigns:manage", "campaigns:approve", "privacy:manage", "jobs:manage"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Single source of truth for role -> permission. `saas_admin` is platform-level and intentionally absent (ADR-011). */
export const ROLE_PERMISSIONS: Readonly<Record<MembershipRole, readonly Permission[]>> = {
  org_admin: PERMISSIONS,
  campaign_manager: ["organization:read", "members:read", "catalog:read", "prospects:read", "prospects:manage", "suppressions:manage", "leads:read", "crm:read", "analytics:read", "ai:use", "campaigns:read", "campaigns:manage"],
  sales_manager: ["organization:read", "members:read", "catalog:read", "catalog:manage", "prospects:read", "prospects:manage", "suppressions:manage", "scoring:manage", "leads:read", "leads:review", "crm:read", "crm:work", "crm:manage", "quotes:read", "quotes:manage", "analytics:read", "ai:use", "campaigns:read", "campaigns:manage", "campaigns:approve"],
  seller: ["organization:read", "catalog:read", "prospects:read", "prospects:manage", "leads:read", "crm:read", "crm:work", "quotes:read", "quotes:manage", "ai:use"],
  analyst: ["organization:read", "catalog:read", "prospects:read", "leads:read", "crm:read", "quotes:read", "analytics:read"],
  viewer: ["organization:read", "catalog:read", "prospects:read", "leads:read", "crm:read", "quotes:read", "analytics:read"],
};

export function hasPermission(role: MembershipRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/* ---------- Request schemas ---------- */

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const password = z.string().min(12).max(128);
const roleSchema = z.enum(MEMBERSHIP_ROLES);

export const RegisterRequest = z.strictObject({
  email,
  password,
  displayName: z.string().trim().min(1).max(100),
  organizationName: z.string().trim().min(2).max(100),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

/** An authenticated user creates another organization (becomes its org_admin). Same name rules as RegisterRequest. */
export const CreateOrganizationRequest = z.strictObject({ organizationName: z.string().trim().min(2).max(100) });
export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequest>;

export const LoginRequest = z.strictObject({
  email,
  password: z.string().min(1).max(128),
  /** Optional hint to choose among the user's memberships; always verified server-side. */
  organizationSlug: z.string().min(1).max(64).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/** Hint only: verified against the caller's own memberships; unknown or foreign slugs are indistinguishable (404). */
export const SwitchOrganizationRequest = z.strictObject({ organizationSlug: z.string().min(1).max(64) });
export type SwitchOrganizationRequest = z.infer<typeof SwitchOrganizationRequest>;

export const UpdateOrganizationRequest = z.strictObject({ name: z.string().trim().min(2).max(100) });
export type UpdateOrganizationRequest = z.infer<typeof UpdateOrganizationRequest>;

export const AddMemberRequest = z.strictObject({ email, role: roleSchema });
export type AddMemberRequest = z.infer<typeof AddMemberRequest>;

export const UpdateMemberRequest = z.strictObject({ role: roleSchema });
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequest>;

export const CreateInvitationRequest = z.strictObject({ email, role: roleSchema });
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequest>;

/** Invitation tokens are 32 random bytes, base64url (43 chars). */
export const AcceptInvitationRequest = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequest>;

/* ---------- Company profile & branches (P3-01) ---------- */

const text = (max: number) => z.string().trim().min(1).max(max);
const country = z.string().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2, upper case");
const currency = z.string().regex(/^[A-Z]{3}$/, "ISO 4217, upper case");
const timezone = z.string().refine((v) => v === "UTC" || Intl.supportedValuesOf("timeZone").includes(v), "IANA time zone");
const httpUrl = z
  .url()
  .max(300)
  .refine((v) => /^https?:\/\//i.test(v), "http(s) only");

/** PUT replaces the whole profile: omitted or null fields are cleared. Nothing is inferred or prefilled. */
export const UpdateProfileRequest = z.strictObject({
  legalName: text(200).nullish(),
  tradeName: text(200).nullish(),
  industry: text(100).nullish(),
  website: httpUrl.nullish(),
  description: text(2000).nullish(),
  country: country.nullish(),
  timezone: timezone.nullish(),
  defaultCurrency: currency.nullish(),
});
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;

export const CreateBranchRequest = z.strictObject({
  name: text(120),
  address: text(300).nullish(),
  city: text(100).nullish(),
  region: text(100).nullish(),
  country: country.nullish(),
});
export type CreateBranchRequest = z.infer<typeof CreateBranchRequest>;

export const UpdateBranchRequest = z
  .strictObject({
    name: text(120).optional(),
    address: text(300).nullable().optional(),
    city: text(100).nullable().optional(),
    region: text(100).nullable().optional(),
    country: country.nullable().optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "at least one field is required");
export type UpdateBranchRequest = z.infer<typeof UpdateBranchRequest>;

/* ---------- Catalog (P3-02) ---------- */

const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const feature = z.strictObject({ name: text(60), value: text(200) });
const features = z
  .array(feature)
  .max(50)
  .refine((list) => new Set(list.map((f) => f.name.toLowerCase())).size === list.length, "feature names must be unique");
const nonEmpty = (v: object) => Object.keys(v).length > 0;

export const CreateCategoryRequest = z.strictObject({ name: text(100) });
export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequest>;
export const UpdateCategoryRequest = z.strictObject({ name: text(100).optional(), status: z.enum(["active", "disabled"]).optional() }).refine(nonEmpty, "at least one field is required");
export type UpdateCategoryRequest = z.infer<typeof UpdateCategoryRequest>;

/** Creates the item and its version 1 as a DRAFT. Nothing is consumable until an org_admin approves it. */
export const CreateItemRequest = z.strictObject({
  kind: z.enum(["product", "service"]),
  sku: z.string().regex(SKU, "letters, digits, . _ - (max 64)"),
  name: text(200),
  description: text(4000).nullish(),
  unit: text(30).nullish(),
  categoryId: z.uuid().nullish(),
  features: features.optional(),
});
export type CreateItemRequest = z.infer<typeof CreateItemRequest>;

/** Edits the open draft only (approved versions are immutable). */
export const UpdateItemDraftRequest = z
  .strictObject({
    name: text(200).optional(),
    description: text(4000).nullable().optional(),
    unit: text(30).nullable().optional(),
    categoryId: z.uuid().nullable().optional(),
    features: features.optional(),
  })
  .refine(nonEmpty, "at least one field is required");
export type UpdateItemDraftRequest = z.infer<typeof UpdateItemDraftRequest>;

export const ITEM_STATUSES = ["draft", "approved", "archived"] as const;
export const ItemListQuery = z.strictObject({
  status: z.enum(["all", ...ITEM_STATUSES]).default("all"),
  kind: z.enum(["product", "service"]).optional(),
  categoryId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().regex(/^[a-z0-9._-]{1,64}$/).optional(),
});
export type ItemListQuery = z.infer<typeof ItemListQuery>;

/* ---------- Price lists (P3-03) ---------- */

/** Exact decimal as a STRING (never a JSON number): up to 14 integer and 4 fraction digits. */
export const MoneyString = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, "decimal string, up to 14 integer and 4 fraction digits");
const isoCurrency = z.string().regex(/^[A-Z]{3}$/).refine((v) => Intl.supportedValuesOf("currency").includes(v), "ISO 4217 currency code");
const validFrom = z.iso.date();

export const CreatePriceListRequest = z
  .strictObject({ name: text(120), currency: isoCurrency, validFrom: validFrom.nullish(), validUntil: validFrom.nullish() })
  .refine((v) => !v.validFrom || !v.validUntil || v.validUntil >= v.validFrom, { message: "validUntil must not precede validFrom", path: ["validUntil"] });
export type CreatePriceListRequest = z.infer<typeof CreatePriceListRequest>;

/** Currency is immutable after creation (prices would silently change meaning). */
export const UpdatePriceListRequest = z
  .strictObject({ name: text(120).optional(), validFrom: validFrom.nullable().optional(), validUntil: validFrom.nullable().optional() })
  .refine(nonEmpty, "at least one field is required")
  .refine((v) => !v.validFrom || !v.validUntil || v.validUntil >= v.validFrom, { message: "validUntil must not precede validFrom", path: ["validUntil"] });
export type UpdatePriceListRequest = z.infer<typeof UpdatePriceListRequest>;

export const ClonePriceListRequest = z.strictObject({ name: text(120) });
export type ClonePriceListRequest = z.infer<typeof ClonePriceListRequest>;
export const SetPriceRequest = z.strictObject({ unitPrice: MoneyString });
export type SetPriceRequest = z.infer<typeof SetPriceRequest>;

export const PriceListQuery = z.strictObject({
  status: z.enum(["all", "draft", "approved", "archived"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});
export type PriceListQuery = z.infer<typeof PriceListQuery>;
export const PageQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.uuid().optional() });
export type PageQuery = z.infer<typeof PageQuery>;

/* ---------- CSV import (P3-04) ---------- */

export const IMPORT_LIMITS = { maxRows: 1000, maxColumns: 60, maxChars: 1_000_000, maxFieldLength: 5000, maxReportedErrors: 100 } as const;

/** Columns: sku, kind, name (required); description, unit, category (optional); any number of `feature:<Name>`. */
export const ImportRequest = z.strictObject({ mode: z.enum(["dry_run", "apply"]), csv: z.string().min(1).max(IMPORT_LIMITS.maxChars) });
export type ImportRequest = z.infer<typeof ImportRequest>;

/** One CSV row after header mapping. `category` is the NAME of an existing active category (never auto-created). */
export const ImportRow = z.strictObject({
  kind: z.enum(["product", "service"]),
  sku: z.string().regex(SKU, "letters, digits, . _ - (max 64)"),
  name: text(200),
  description: text(4000).nullish(),
  unit: text(30).nullish(),
  category: text(100).nullish(),
  features: features.optional(),
});
export type ImportRow = z.infer<typeof ImportRow>;

/* ---------- Evidence for AI / quotes (P3-06) ---------- */

export const EvidenceQuery = z.strictObject({ sku: z.string().regex(SKU, "letters, digits, . _ - (max 64)"), priceListId: z.uuid().optional() });
export type EvidenceQuery = z.infer<typeof EvidenceQuery>;
export const MAX_RESOLVE_REFS = 50;
export const ResolveRefsRequest = z.strictObject({ refs: z.array(z.string().max(100)).min(1).max(MAX_RESOLVE_REFS) });
export type ResolveRefsRequest = z.infer<typeof ResolveRefsRequest>;

/* ---------- Prospects & suppression (P4-01) ---------- */

const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** "https://www.Example.com:8080/path?x" -> "example.com"; emails, IPs, userinfo and non-ASCII (use punycode) are rejected (null). */
export function normalizeDomain(input: string): string | null {
  let v = input.trim().toLowerCase();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  v = v.split(/[/?#]/)[0] ?? "";
  if (v.includes("@")) return null;
  v = v.replace(/:\d{1,5}$/, "").replace(/^www\./, "").replace(/\.$/, "");
  return v.length <= 253 && DOMAIN.test(v) ? v : null;
}
export const normalizeNameKey = (name: string): string => name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
/** Dedupe identity of a prospect: its domain, or name|country when it has none. */
export const prospectKeys = (name: string, domain: string | null | undefined, country: string | null | undefined) => {
  const domainKey = domain ? normalizeDomain(domain) : null;
  const nameKey = normalizeNameKey(name);
  return { domainKey, nameKey, dedupeKey: domainKey ?? `${nameKey}|${country ?? ""}` };
};

const domainField = z.string().trim().max(300).refine((v) => normalizeDomain(v) !== null, "a domain or URL such as example.com");
export const PROSPECT_STATUSES = ["candidate", "qualified", "disqualified"] as const;

export const CreateProspectRequest = z.strictObject({
  name: text(200),
  domain: domainField.nullish(),
  country: country.nullish(),
  region: text(100).nullish(),
  city: text(100).nullish(),
  industry: text(100).nullish(),
  notes: text(2000).nullish(),
});
export type CreateProspectRequest = z.infer<typeof CreateProspectRequest>;
export const UpdateProspectRequest = z
  .strictObject({
    name: text(200).optional(),
    domain: domainField.nullable().optional(),
    country: country.nullable().optional(),
    region: text(100).nullable().optional(),
    city: text(100).nullable().optional(),
    industry: text(100).nullable().optional(),
    notes: text(2000).nullable().optional(),
  })
  .refine(nonEmpty, "at least one field is required");
export type UpdateProspectRequest = z.infer<typeof UpdateProspectRequest>;
export const SetProspectStatusRequest = z.strictObject({ status: z.enum(PROSPECT_STATUSES), reason: text(200).nullish() });
export type SetProspectStatusRequest = z.infer<typeof SetProspectStatusRequest>;
export const ProspectListQuery = z.strictObject({
  status: z.enum(["all", ...PROSPECT_STATUSES]).default("all"),
  country: country.optional(),
  suppressed: z.enum(["true", "false"]).optional(),
  q: text(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});
export type ProspectListQuery = z.infer<typeof ProspectListQuery>;
export const ProspectExportQuery = z.strictObject({ status: z.enum(["all", ...PROSPECT_STATUSES]).default("all"), country: country.optional() });
export type ProspectExportQuery = z.infer<typeof ProspectExportQuery>;

/** Hides `duplicateId` behind the path prospect (the survivor). Non-destructive and reversible; nothing is moved or deleted. */
export const MergeProspectRequest = z.strictObject({ duplicateId: z.uuid(), reason: text(200) });
export type MergeProspectRequest = z.infer<typeof MergeProspectRequest>;

export const CreateSuppressionRequest = z
  .strictObject({ kind: z.enum(["domain", "name"]), value: text(300), reason: text(200) })
  .refine((v) => v.kind !== "domain" || normalizeDomain(v.value) !== null, { message: "a domain or URL such as example.com", path: ["value"] });
export type CreateSuppressionRequest = z.infer<typeof CreateSuppressionRequest>;

/** Prospect CSV: name (required); domain, country, region, city, industry (optional). Natural key = domain, else name|country. */
export const ProspectImportRow = z.strictObject({
  name: text(200),
  domain: domainField.nullish(),
  country: country.nullish(),
  region: text(100).nullish(),
  city: text(100).nullish(),
  industry: text(100).nullish(),
});
export type ProspectImportRow = z.infer<typeof ProspectImportRow>;

/* ---------- Attributes, scoring, intent and leads (P5-01, P8-01) ---------- */

export const ATTRIBUTE_KEY = /^[a-z][a-z0-9_]{0,39}$/;
export const CONFIDENCES = ["low", "medium", "high"] as const;
export const CreateAttributeRequest = z.strictObject({ key: z.string().regex(ATTRIBUTE_KEY, "lower-case letters, digits and _ (max 40)"), value: text(200), confidence: z.enum(CONFIDENCES) });
export type CreateAttributeRequest = z.infer<typeof CreateAttributeRequest>;
export const AttributeDecisionRequest = z.strictObject({ decision: z.enum(["verify", "reject"]) });
export type AttributeDecisionRequest = z.infer<typeof AttributeDecisionRequest>;

export const SCORE_FIELDS = ["country", "industry", "city", "region", "status", "has_domain"] as const;
export const SCORE_OPS = ["eq", "neq", "in", "gte", "lte", "exists", "missing"] as const;
/** One transparent rule. `field` rules read prospect columns; `attribute` rules read VERIFIED attributes only. */
export const ScoreRule = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, "lower-case id"),
    label: text(100),
    source: z.enum(["field", "attribute"]),
    name: z.string().min(1).max(40),
    op: z.enum(SCORE_OPS),
    value: z.union([z.string().max(100), z.number().finite(), z.array(z.string().max(100)).min(1).max(20)]).optional(),
    points: z.number().int().min(-100).max(100),
  })
  .superRefine((r, ctx) => {
    const bad = (message: string, path: string) => ctx.addIssue({ code: "custom", message, path: [path] });
    if (r.source === "field" && !(SCORE_FIELDS as readonly string[]).includes(r.name)) bad("unknown prospect field", "name");
    if (r.source === "attribute" && !ATTRIBUTE_KEY.test(r.name)) bad("invalid attribute key", "name");
    if (r.op === "exists" || r.op === "missing") {
      if (r.value !== undefined) bad("this operator takes no value", "value");
    } else if (r.op === "in") {
      if (!Array.isArray(r.value)) bad("a list of values is required", "value");
    } else if (r.op === "gte" || r.op === "lte") {
      if (typeof r.value !== "number") bad("a number is required", "value");
    } else if (r.value === undefined || Array.isArray(r.value)) bad("a single value is required", "value");
  });
export type ScoreRule = z.infer<typeof ScoreRule>;
export const SaveScoringDraftRequest = z
  .strictObject({ rules: z.array(ScoreRule).max(50) })
  .refine((v) => new Set(v.rules.map((r) => r.id)).size === v.rules.length, { message: "rule ids must be unique", path: ["rules"] });
export type SaveScoringDraftRequest = z.infer<typeof SaveScoringDraftRequest>;

export const SetLeadSettingsRequest = z.strictObject({ minScore: z.number().int().min(-1000).max(1000) });
export type SetLeadSettingsRequest = z.infer<typeof SetLeadSettingsRequest>;
export const LeadListQuery = z.strictObject({
  state: z.enum(["all", "pending_review", "accepted", "rejected"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});
export type LeadListQuery = z.infer<typeof LeadListQuery>;
export const LeadDecisionRequest = z.strictObject({ decision: z.enum(["accept", "reject"]), note: text(300).nullish() });
export type LeadDecisionRequest = z.infer<typeof LeadDecisionRequest>;
export const AssessReplyRequest = z.strictObject({ text: z.string().trim().min(1).max(4000) });
export type AssessReplyRequest = z.infer<typeof AssessReplyRequest>;

/* ---------- CRM (P9-01) ---------- */

export const OPPORTUNITY_STAGES = ["new", "contacted", "qualification", "quote_requested", "quote_sent", "negotiation", "won", "lost", "future"] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];
/** Valid stage moves. The database function crm_stage_allowed is the authority; an integration test proves both agree. */
export const OPPORTUNITY_TRANSITIONS: Readonly<Record<OpportunityStage, readonly OpportunityStage[]>> = {
  new: ["contacted", "lost", "future"],
  contacted: ["qualification", "lost", "future"],
  qualification: ["quote_requested", "quote_sent", "negotiation", "lost", "future"],
  quote_requested: ["quote_sent", "lost", "future"],
  quote_sent: ["negotiation", "won", "lost", "future"],
  negotiation: ["quote_sent", "won", "lost", "future"],
  future: ["contacted", "lost"],
  won: [],
  lost: [],
};
const currencyCode = z.string().regex(/^[A-Z]{3}$/).refine((v) => Intl.supportedValuesOf("currency").includes(v), "ISO 4217 currency code");

/** An opportunity is created from exactly one ACCEPTED lead. */
export const CreateOpportunityRequest = z
  .strictObject({ leadId: z.uuid(), title: text(200), expectedValue: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).nullish(), currency: currencyCode.nullish() })
  .refine((v) => (v.expectedValue == null) === (v.currency == null), { message: "expectedValue and currency go together", path: ["currency"] });
export type CreateOpportunityRequest = z.infer<typeof CreateOpportunityRequest>;
export const ChangeStageRequest = z
  .strictObject({ stage: z.enum(OPPORTUNITY_STAGES), note: text(300).nullish(), lossReason: text(200).nullish() })
  .refine((v) => (v.stage === "lost") === (v.lossReason != null), { message: "lossReason is required for lost and only for lost", path: ["lossReason"] });
export type ChangeStageRequest = z.infer<typeof ChangeStageRequest>;
export const AddNoteRequest = z.strictObject({ kind: z.enum(["note", "call", "email", "meeting"]), body: text(2000) });
export type AddNoteRequest = z.infer<typeof AddNoteRequest>;
/** userId null returns the opportunity to the unassigned queue. */
export const AssignRequest = z.strictObject({ userId: z.uuid().nullable() });
export type AssignRequest = z.infer<typeof AssignRequest>;
export const RoutingSettingsRequest = z.strictObject({ strategy: z.enum(["manual", "round_robin"]), firstResponseSlaMinutes: z.number().int().min(1).max(10080).nullable() });
export type RoutingSettingsRequest = z.infer<typeof RoutingSettingsRequest>;
export const PoolMemberRequest = z.strictObject({ active: z.boolean(), maxOpen: z.number().int().min(1).max(500) });
export type PoolMemberRequest = z.infer<typeof PoolMemberRequest>;
export const OpportunityListQuery = z.strictObject({
  stage: z.enum(["all", ...OPPORTUNITY_STAGES]).default("all"),
  owner: z.union([z.enum(["me", "unassigned"]), z.uuid()]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});
export type OpportunityListQuery = z.infer<typeof OpportunityListQuery>;

/* ---------- Follow-up tasks (P9-02) ---------- */

export const TASK_STATES = ["open", "done", "cancelled"] as const;
export const CreateTaskRequest = z.strictObject({ title: text(200), dueAt: z.iso.datetime(), assigneeUserId: z.uuid().optional() });
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;
export const TaskListQuery = z.strictObject({
  state: z.enum(["all", ...TASK_STATES]).default("open"),
  assignee: z.union([z.literal("me"), z.uuid()]).optional(),
  overdue: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});
export type TaskListQuery = z.infer<typeof TaskListQuery>;
export const TaskDto = z.object({
  id: z.uuid(),
  opportunityId: z.uuid(),
  opportunityTitle: z.string(),
  title: z.string(),
  dueAt: z.iso.datetime(),
  state: z.enum(TASK_STATES),
  assigneeUserId: z.uuid(),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  overdue: z.boolean(),
});
export type TaskDto = z.infer<typeof TaskDto>;
export const TaskPageDto = z.object({ items: z.array(TaskDto), nextCursor: z.uuid().nullable() });
export type TaskPageDto = z.infer<typeof TaskPageDto>;

// F9: in-app notifications (sandbox channel only; no email or WhatsApp).
export const NOTIFICATION_TYPES = ["task_overdue", "task_due_soon", "lead_assigned", "opportunity_assigned", "sla_breached", "draft_pending_review"] as const;
export const NotificationType = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof NotificationType>;
export const NotificationListQuery = z.strictObject({
  unread: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});
export type NotificationListQuery = z.infer<typeof NotificationListQuery>;
export const NotificationDto = z.object({
  id: z.uuid(),
  type: NotificationType,
  title: z.string(),
  body: z.string().nullable(),
  resourceType: z.string().nullable(),
  resourceId: z.uuid().nullable(),
  channel: z.literal("sandbox"),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});
export type NotificationDto = z.infer<typeof NotificationDto>;
export const NotificationPageDto = z.object({ items: z.array(NotificationDto), nextCursor: z.uuid().nullable() });
export type NotificationPageDto = z.infer<typeof NotificationPageDto>;
export const NotificationCountDto = z.object({ unread: z.number().int().min(0) });
export type NotificationCountDto = z.infer<typeof NotificationCountDto>;
export const NotificationReadAllDto = z.object({ updated: z.number().int().min(0) });
export type NotificationReadAllDto = z.infer<typeof NotificationReadAllDto>;
export const NotificationPreferencesDto = z.object({ items: z.array(z.object({ type: NotificationType, enabled: z.boolean() })) });
export type NotificationPreferencesDto = z.infer<typeof NotificationPreferencesDto>;
export const UpdateNotificationPreferencesRequest = z.strictObject({
  preferences: z.array(z.strictObject({ type: NotificationType, enabled: z.boolean() })).min(1).max(NOTIFICATION_TYPES.length),
});
export type UpdateNotificationPreferencesRequest = z.infer<typeof UpdateNotificationPreferencesRequest>;

/* ---------- AI gateway (F6, provider-neutral) ---------- */

export const AI_CAPABILITIES = ["offer_brief"] as const;
export const AI_RUN_STATUSES = ["ok", "needs_review", "blocked", "budget_exceeded", "provider_error", "schema_invalid"] as const;
/** Raw model output contract (prompts ask for exactly this). Evidence ids must come from the evidence the gateway supplied. */
export const AiModelOutput = z.strictObject({
  summary: z.string().trim().min(1).max(1200),
  evidence_ids: z.array(z.string().max(100)).min(1).max(10),
  confidence: z.number().min(0).max(1),
  needs_review: z.boolean(),
});
export type AiModelOutput = z.infer<typeof AiModelOutput>;
export const AiAnalyzeRequest = z.strictObject({
  capability: z.enum(AI_CAPABILITIES),
  /** Untrusted content (for example a pasted reply). It is minimised and labelled as data before it reaches a model. */
  text: z.string().trim().min(1).max(4000),
  /** Approved evidence refs ("item:<id>:v<n>", "price:<entryId>"); the model may only cite these. */
  evidenceRefs: z.array(z.string().max(100)).min(1).max(10),
});
export type AiAnalyzeRequest = z.infer<typeof AiAnalyzeRequest>;
export const AiRunDto = z.object({
  id: z.uuid(),
  capability: z.string(),
  promptKey: z.string(),
  promptVersion: z.number().int(),
  provider: z.string(),
  model: z.string(),
  status: z.enum(AI_RUN_STATUSES),
  needsReview: z.boolean(),
  flags: z.array(z.string()),
  confidence: z.number().nullable(),
  evidenceRefs: z.array(z.string()),
  output: z.object({ summary: z.string(), evidenceIds: z.array(z.string()) }).nullable(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costMicros: z.number().int(),
  latencyMs: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type AiRunDto = z.infer<typeof AiRunDto>;
export const AiRunListQuery = z.strictObject({
  needsReview: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});
export type AiRunListQuery = z.infer<typeof AiRunListQuery>;
export const AiRunPageDto = z.object({ items: z.array(AiRunDto), nextCursor: z.uuid().nullable() });
export type AiRunPageDto = z.infer<typeof AiRunPageDto>;
export const SetAiBudgetRequest = z.strictObject({ monthlyLimitMicros: z.number().int().min(0).max(1_000_000_000_000) });
export type SetAiBudgetRequest = z.infer<typeof SetAiBudgetRequest>;
export const AiUsageDto = z.object({
  period: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }),
  monthlyLimitMicros: z.number().int().nullable(),
  spentMicros: z.number().int(),
  remainingMicros: z.number().int().nullable(),
  runs: z.number().int(),
  needsReview: z.number().int(),
  byCapability: z.array(z.object({ capability: z.string(), runs: z.number().int(), costMicros: z.number().int() })),
});
export type AiUsageDto = z.infer<typeof AiUsageDto>;

/* ---------- Contacts, consent and campaigns (F7 domain; sandbox channel only) ---------- */

export const CAMPAIGN_STATES = ["draft", "approved", "running", "paused", "completed", "cancelled"] as const;
export const ATTEMPT_STATES = ["queued", "sent", "skipped", "failed", "cancelled"] as const;
export const UNSUBSCRIBE_PLACEHOLDER = "{{unsubscribe_url}}";
const campaignBody = z.string().trim().min(1).max(5000).refine((v) => v.includes(UNSUBSCRIBE_PLACEHOLDER), { message: "the body must include {{unsubscribe_url}}" });

export const E164 = /^\+[1-9][0-9]{7,14}$/;
export const AddContactRequest = z
  .strictObject({ channel: z.enum(["email", "whatsapp"]).default("email"), address: z.string().trim().min(1).max(254), displayName: text(120).optional(), source: text(300).min(3) })
  .superRefine((v, ctx) => {
    if (v.channel === "whatsapp" ? !E164.test(v.address) : !z.email().safeParse(v.address).success) {
      ctx.addIssue({ code: "custom", path: ["address"], message: v.channel === "whatsapp" ? "a WhatsApp number must be E.164 (+ and 8-15 digits)" : "a valid email address is required" });
    }
  });
export type AddContactRequest = z.infer<typeof AddContactRequest>;
/** Consent is only ever recorded by a person, with the evidence of how and when it was given or withdrawn. Nothing is defaulted. */
export const RecordConsentRequest = z.strictObject({ event: z.enum(["granted", "withdrawn"]), evidence: text(500).min(3), occurredAt: z.iso.datetime() });
export type RecordConsentRequest = z.infer<typeof RecordConsentRequest>;
export const ContactDto = z.object({
  id: z.uuid(),
  prospectId: z.uuid(),
  channel: z.enum(["email", "whatsapp"]),
  address: z.string(),
  displayName: z.string().nullable(),
  source: z.string(),
  status: z.enum(["active", "opted_out", "bounced", "restricted", "erased"]),
  consent: z.enum(["granted", "withdrawn", "none"]),
  consentAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type ContactDto = z.infer<typeof ContactDto>;
export const ContactListDto = z.object({ items: z.array(ContactDto) });
export type ContactListDto = z.infer<typeof ContactListDto>;

export const CreateCampaignRequest = z.strictObject({ name: text(120), subject: text(200), body: campaignBody, minDaysBetween: z.number().int().min(0).max(365).default(7) });
export type CreateCampaignRequest = z.infer<typeof CreateCampaignRequest>;
export const UpdateCampaignRequest = z
  .strictObject({ name: text(120).optional(), subject: text(200).optional(), body: campaignBody.optional(), minDaysBetween: z.number().int().min(0).max(365).optional() })
  .refine((v) => Object.keys(v).length > 0, "at least one field is required");
export type UpdateCampaignRequest = z.infer<typeof UpdateCampaignRequest>;
export const CampaignListQuery = z.strictObject({
  state: z.enum(["all", ...CAMPAIGN_STATES]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});
export type CampaignListQuery = z.infer<typeof CampaignListQuery>;
export const CampaignDto = z.object({
  id: z.uuid(),
  name: z.string(),
  subject: z.string(),
  body: z.string(),
  state: z.enum(CAMPAIGN_STATES),
  minDaysBetween: z.number().int(),
  createdBy: z.uuid(),
  approvedAt: z.iso.datetime().nullable(),
  launchedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  attempts: z.object({ queued: z.number().int(), sent: z.number().int(), skipped: z.number().int(), failed: z.number().int(), cancelled: z.number().int() }),
});
export type CampaignDto = z.infer<typeof CampaignDto>;
export const CampaignPageDto = z.object({ items: z.array(CampaignDto), nextCursor: z.uuid().nullable() });
export type CampaignPageDto = z.infer<typeof CampaignPageDto>;
export const EXCLUSION_REASONS = ["no_consent", "opted_out", "bounced", "suppressed", "recently_contacted", "already_in_campaign"] as const;
export const AudiencePreviewDto = z.object({
  total: z.number().int(),
  eligible: z.number().int(),
  excluded: z.object({ no_consent: z.number().int(), opted_out: z.number().int(), bounced: z.number().int(), suppressed: z.number().int(), recently_contacted: z.number().int(), already_in_campaign: z.number().int() }),
});
export type AudiencePreviewDto = z.infer<typeof AudiencePreviewDto>;
export const DispatchRequest = z.strictObject({ limit: z.number().int().min(1).max(200).default(50) });
export type DispatchRequest = z.infer<typeof DispatchRequest>;
export const DispatchResultDto = z.object({
  processed: z.number().int(),
  sent: z.number().int(),
  failed: z.number().int(),
  skipped: z.record(z.string(), z.number().int()),
  remainingQueued: z.number().int(),
  campaignState: z.enum(CAMPAIGN_STATES),
});
export type DispatchResultDto = z.infer<typeof DispatchResultDto>;
export const AttemptListQuery = z.strictObject({
  state: z.enum(["all", ...ATTEMPT_STATES]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});
export type AttemptListQuery = z.infer<typeof AttemptListQuery>;
export const AttemptDto = z.object({
  id: z.uuid(),
  contactId: z.uuid(),
  address: z.string(),
  state: z.enum(ATTEMPT_STATES),
  skipReason: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  attemptedAt: z.iso.datetime().nullable(),
});
export type AttemptDto = z.infer<typeof AttemptDto>;
export const AttemptPageDto = z.object({ items: z.array(AttemptDto), nextCursor: z.uuid().nullable() });
export type AttemptPageDto = z.infer<typeof AttemptPageDto>;
/** Public self-service unsubscribe: the signature is an HMAC over org + contact, produced when the message was rendered. */
export const UnsubscribeRequest = z.strictObject({ org: z.uuid(), contact: z.uuid(), sig: z.string().regex(/^[0-9a-f]{64}$/) });
export type UnsubscribeRequest = z.infer<typeof UnsubscribeRequest>;

/* ---------- Quotes and sales (P10-01) ---------- */

export const QUOTE_STATUSES = ["draft", "sent", "accepted", "rejected", "cancelled"] as const;
const quantity = z.string().regex(/^\d{1,10}(\.\d{1,4})?$/, "decimal, up to 4 fraction digits").refine((v) => Number(v) > 0, "greater than zero");
const percent2 = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, "percentage with up to 2 decimals").refine((v) => Number(v) <= 100, "at most 100");
const taxRate = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, "percentage with up to 4 decimals").refine((v) => Number(v) <= 100, "at most 100");

export const CreateQuoteRequest = z.strictObject({
  opportunityId: z.uuid(),
  priceListId: z.uuid(),
  validUntil: z.iso.date().nullish(),
  /** Entered explicitly by the user (a percentage); there is no default tax. */
  taxRate: taxRate.nullish(),
  notes: text(1000).nullish(),
});
export type CreateQuoteRequest = z.infer<typeof CreateQuoteRequest>;
export const UpdateQuoteRequest = z
  .strictObject({ validUntil: z.iso.date().nullable().optional(), taxRate: taxRate.nullable().optional(), notes: text(1000).nullable().optional() })
  .refine(nonEmpty, "at least one field is required");
export type UpdateQuoteRequest = z.infer<typeof UpdateQuoteRequest>;
/** A line is built from APPROVED evidence for the SKU in the quote's price list; the price is never typed in. */
export const AddQuoteLineRequest = z.strictObject({ sku: z.string().regex(SKU, "letters, digits, . _ - (max 64)"), quantity, discountPercent: percent2.optional() });
export type AddQuoteLineRequest = z.infer<typeof AddQuoteLineRequest>;
export const QuoteDecisionRequest = z.strictObject({ decision: z.enum(["accept", "reject", "cancel"]), note: text(300).nullish() });
export type QuoteDecisionRequest = z.infer<typeof QuoteDecisionRequest>;
export const SetQuoteSettingsRequest = z.strictObject({ maxDiscountPercent: percent2 });
export type SetQuoteSettingsRequest = z.infer<typeof SetQuoteSettingsRequest>;
export const QuoteListQuery = z.strictObject({
  opportunityId: z.uuid().optional(),
  status: z.enum(["all", ...QUOTE_STATUSES]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});
export type QuoteListQuery = z.infer<typeof QuoteListQuery>;

/* ---------- Analytics (P11-01) ---------- */

/** Windows are UTC calendar days, inclusive on both ends, at most 366 days. Defaults (applied by the server): the last 30 days. */
const windowShape = { from: z.iso.date().optional(), to: z.iso.date().optional() };
const validWindow = (v: { from?: string | undefined; to?: string | undefined }) => {
  if (!v.from || !v.to) return true;
  const days = (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000;
  return days >= 0 && days <= 365;
};
export const AnalyticsQuery = z.strictObject(windowShape).refine(validWindow, { message: "from must not be after to, and the window is at most 366 days", path: ["to"] });
export type AnalyticsQuery = z.infer<typeof AnalyticsQuery>;
export const ANALYTICS_EVENT_METRICS = ["prospects_created", "leads_created", "opportunities_created", "quotes_sent", "sales_closed", "opportunities_lost"] as const;
export const AnalyticsEventsQuery = z
  .strictObject({ ...windowShape, metric: z.enum(ANALYTICS_EVENT_METRICS), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.uuid().optional() })
  .refine(validWindow, { message: "from must not be after to, and the window is at most 366 days", path: ["to"] });
export type AnalyticsEventsQuery = z.infer<typeof AnalyticsEventsQuery>;

/** Exports: same window/filters as the drill-down, without paging (the server caps the rows and says so in a header). */
export const AnalyticsExportQuery = z
  .strictObject({ ...windowShape, metric: z.enum(ANALYTICS_EVENT_METRICS) })
  .refine(validWindow, { message: "from must not be after to, and the window is at most 366 days", path: ["to"] });
export type AnalyticsExportQuery = z.infer<typeof AnalyticsExportQuery>;

export const UuidParam = z.uuid();

export const AuditQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50) });
export type AuditQuery = z.infer<typeof AuditQuery>;

export const IdempotencyKeyHeader = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{8,128}$/)
  .optional();

/* ---------- Responses (zod = single source for types and OpenAPI) ---------- */

export const OrganizationDto = z.object({ id: z.uuid(), name: z.string(), slug: z.string() });
export type OrganizationDto = z.infer<typeof OrganizationDto>;
export const UserDto = z.object({ id: z.uuid(), email: z.string(), displayName: z.string() });
export type UserDto = z.infer<typeof UserDto>;
export const SessionDto = z.object({ token: z.string(), expiresAt: z.iso.datetime(), organization: OrganizationDto, role: roleSchema });
export type SessionDto = z.infer<typeof SessionDto>;
export const MeDto = z.object({ user: UserDto, organization: OrganizationDto, role: roleSchema, permissions: z.array(z.enum(PERMISSIONS)) });
export type MeDto = Readonly<{ user: UserDto; organization: OrganizationDto; role: MembershipRole; permissions: readonly Permission[] }>;
export const MemberDto = z.object({ id: z.uuid(), user: UserDto, role: roleSchema, status: z.enum(["active", "disabled"]) });
export type MemberDto = z.infer<typeof MemberDto>;
export const AuditEventDto = z.object({
  id: z.uuid(),
  actorUserId: z.uuid().nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  metadata: z.unknown(),
  createdAt: z.iso.datetime(),
});
export type AuditEventDto = z.infer<typeof AuditEventDto>;

export const InvitationDto = z.object({
  id: z.uuid(),
  email: z.string(),
  role: roleSchema,
  invitedBy: z.uuid(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type InvitationDto = z.infer<typeof InvitationDto>;
/** The raw token is returned exactly once, at creation (no email provider yet; the admin delivers it out of band). */
export const InvitationCreatedDto = InvitationDto.extend({ token: z.string() });
export type InvitationCreatedDto = z.infer<typeof InvitationCreatedDto>;
export const AcceptedInvitationDto = z.object({ organization: OrganizationDto, role: roleSchema, membershipCreated: z.boolean() });
export type AcceptedInvitationDto = z.infer<typeof AcceptedInvitationDto>;

export const ProfileDto = z.object({
  legalName: z.string().nullable(),
  tradeName: z.string().nullable(),
  industry: z.string().nullable(),
  website: z.string().nullable(),
  description: z.string().nullable(),
  country: z.string().nullable(),
  timezone: z.string().nullable(),
  defaultCurrency: z.string().nullable(),
  updatedAt: z.iso.datetime().nullable(),
});
export type ProfileDto = z.infer<typeof ProfileDto>;
export const BranchDto = z.object({
  id: z.uuid(),
  name: z.string(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  country: z.string().nullable(),
  status: z.enum(["active", "disabled"]),
});
export type BranchDto = z.infer<typeof BranchDto>;

export const CategoryDto = z.object({ id: z.uuid(), name: z.string(), status: z.enum(["active", "disabled"]) });
export type CategoryDto = z.infer<typeof CategoryDto>;
export const FeatureDto = z.object({ name: z.string(), value: z.string() });
export const ItemVersionDto = z.object({
  id: z.uuid(),
  version: z.number().int(),
  state: z.enum(["draft", "approved", "superseded"]),
  name: z.string(),
  description: z.string().nullable(),
  unit: z.string().nullable(),
  categoryId: z.uuid().nullable(),
  features: z.array(FeatureDto),
  createdBy: z.uuid(),
  approvedBy: z.uuid().nullable(),
  approvedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type ItemVersionDto = z.infer<typeof ItemVersionDto>;
/** `approved` is the only content other modules (quotes, AI) may use; it is null unless an approved version exists and the item is not archived. */
export const ItemDto = z.object({
  id: z.uuid(),
  kind: z.enum(["product", "service"]),
  sku: z.string(),
  status: z.enum(ITEM_STATUSES),
  latestVersion: z.number().int(),
  approvedVersion: z.number().int().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  approved: ItemVersionDto.nullable(),
  draft: ItemVersionDto.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ItemDto = z.infer<typeof ItemDto>;
export const ItemPageDto = z.object({ items: z.array(ItemDto), nextCursor: z.string().nullable() });
export type ItemPageDto = z.infer<typeof ItemPageDto>;

export const PriceListDto = z.object({
  id: z.uuid(),
  name: z.string(),
  currency: z.string(),
  status: z.enum(["draft", "approved", "archived"]),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  clonedFrom: z.uuid().nullable(),
  entryCount: z.number().int(),
  createdAt: z.iso.datetime(),
  approvedAt: z.iso.datetime().nullable(),
  approvedBy: z.uuid().nullable(),
  archivedAt: z.iso.datetime().nullable(),
});
export type PriceListDto = z.infer<typeof PriceListDto>;
export const PriceListPageDto = z.object({ items: z.array(PriceListDto), nextCursor: z.uuid().nullable() });
export type PriceListPageDto = z.infer<typeof PriceListPageDto>;
export const PriceEntryDto = z.object({ id: z.uuid(), itemId: z.uuid(), sku: z.string(), unitPrice: MoneyString });
export type PriceEntryDto = z.infer<typeof PriceEntryDto>;
export const PriceEntryPageDto = z.object({ items: z.array(PriceEntryDto), nextCursor: z.uuid().nullable() });
export type PriceEntryPageDto = z.infer<typeof PriceEntryPageDto>;
/** Consumption view for quotes/AI: only entries of an APPROVED list whose item is currently approved and not archived. */
export const ApprovedPriceDto = z.object({
  priceListId: z.uuid(),
  entryId: z.uuid(),
  itemId: z.uuid(),
  sku: z.string(),
  kind: z.enum(["product", "service"]),
  itemVersion: z.number().int(),
  itemName: z.string(),
  unitPrice: MoneyString,
  currency: z.string(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
});
export type ApprovedPriceDto = z.infer<typeof ApprovedPriceDto>;
export const ApprovedPricePageDto = z.object({ items: z.array(ApprovedPriceDto), nextCursor: z.uuid().nullable() });
export type ApprovedPricePageDto = z.infer<typeof ApprovedPricePageDto>;

export const ImportRowErrorDto = z.object({
  row: z.number().int(),
  sku: z.string().nullable(),
  column: z.string().nullable(),
  code: z.string(),
  message: z.string(),
});
export type ImportRowErrorDto = z.infer<typeof ImportRowErrorDto>;
/** Row numbers are file lines of records (header = 1). Counts are planned in dry_run, applied in applied, zero when rejected. */
export const ImportJobDto = z.object({
  id: z.uuid(),
  mode: z.enum(["dry_run", "apply"]),
  status: z.enum(["valid", "invalid", "applied", "rejected"]),
  fileHash: z.string(),
  totals: z.object({ rows: z.number().int(), created: z.number().int(), updated: z.number().int(), unchanged: z.number().int(), errors: z.number().int() }),
  errors: z.array(ImportRowErrorDto),
  errorsTruncated: z.boolean(),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
});
export type ImportJobDto = z.infer<typeof ImportJobDto>;
export const ImportResultDto = ImportJobDto.extend({
  rows: z.array(z.object({ row: z.number().int(), sku: z.string().nullable(), action: z.enum(["create", "update", "unchanged", "error"]) })),
});
export type ImportResultDto = z.infer<typeof ImportResultDto>;
export const ImportJobPageDto = z.object({ items: z.array(ImportJobDto), nextCursor: z.uuid().nullable() });
export type ImportJobPageDto = z.infer<typeof ImportJobPageDto>;

/**
 * Citable references. `item:<itemId>:v<version>` names one APPROVED item version; `price:<entryId>` names one price of an APPROVED list.
 * A claim about the catalog is only valid if it cites a ref that still resolves as "current" (see POST /catalog/evidence/resolve).
 */
export const EVIDENCE_REASONS = [
  "item_not_found", "item_not_approved", "item_archived", "price_list_not_found", "price_list_not_approved", "price_list_archived",
  "no_price_for_item", "unknown_ref", "malformed_ref", "not_approved",
] as const;
export type EvidenceReason = (typeof EVIDENCE_REASONS)[number];
export const NoEvidenceDto = z.object({ status: z.literal("no_evidence"), reason: z.enum(EVIDENCE_REASONS) });
export const ItemEvidenceDto = z.object({
  status: z.literal("evidence"),
  ref: z.string(),
  itemId: z.uuid(),
  version: z.number().int(),
  kind: z.enum(["product", "service"]),
  sku: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  unit: z.string().nullable(),
  category: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  features: z.array(FeatureDto),
  approvedAt: z.iso.datetime().nullable(),
});
export type ItemEvidenceDto = z.infer<typeof ItemEvidenceDto>;
export const PriceEvidenceDto = z.object({
  status: z.literal("evidence"),
  ref: z.string(),
  priceListId: z.uuid(),
  entryId: z.uuid(),
  itemId: z.uuid(),
  unitPrice: MoneyString,
  currency: z.string(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
});
export type PriceEvidenceDto = z.infer<typeof PriceEvidenceDto>;
/** `price` is present only when a priceListId was asked for. Drafts, unapproved lists and archived items never produce evidence. */
export const EvidenceDto = z.object({
  sku: z.string(),
  item: z.union([ItemEvidenceDto, NoEvidenceDto]),
  price: z.union([PriceEvidenceDto, NoEvidenceDto]).optional(),
});
export type EvidenceDto = z.infer<typeof EvidenceDto>;
export const ResolvedRefDto = z.object({
  ref: z.string(),
  status: z.enum(["current", "superseded", "archived", "no_evidence"]),
  reason: z.enum(EVIDENCE_REASONS).optional(),
  currentRef: z.string().optional(),
  evidence: z.union([ItemEvidenceDto, PriceEvidenceDto]).optional(),
});
export type ResolvedRefDto = z.infer<typeof ResolvedRefDto>;
export const ResolveRefsDto = z.object({ results: z.array(ResolvedRefDto) });
export type ResolveRefsDto = z.infer<typeof ResolveRefsDto>;

export const ProspectDto = z.object({
  id: z.uuid(),
  name: z.string(),
  domain: z.string().nullable(),
  country: z.string().nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  industry: z.string().nullable(),
  notes: z.string().nullable(),
  status: z.enum(PROSPECT_STATUSES),
  statusReason: z.string().nullable(),
  /** True when the domain or name is on the do-not-contact list. */
  suppressed: z.boolean(),
  /** A prospect is only a candidate: it never carries permission to be contacted. */
  contactPermission: z.literal("none"),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProspectDto = z.infer<typeof ProspectDto>;
export const ProspectSourceDto = z.object({ id: z.uuid(), type: z.enum(["manual", "csv_import", "openstreetmap"]), ref: z.string().nullable(), collectedAt: z.iso.datetime(), createdBy: z.uuid() });
export const ProspectDetailDto = ProspectDto.extend({ sources: z.array(ProspectSourceDto) });
export type ProspectDetailDto = z.infer<typeof ProspectDetailDto>;
export const ProspectPageDto = z.object({ items: z.array(ProspectDto), nextCursor: z.uuid().nullable() });
export type ProspectPageDto = z.infer<typeof ProspectPageDto>;
export const SuppressionDto = z.object({ id: z.uuid(), kind: z.enum(["domain", "name"]), value: z.string(), reason: z.string(), createdAt: z.iso.datetime() });
export type SuppressionDto = z.infer<typeof SuppressionDto>;
export const SuppressionListDto = z.object({ items: z.array(SuppressionDto) });
export type SuppressionListDto = z.infer<typeof SuppressionListDto>;
export const ConnectorsDto = z.object({ connectors: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() })), note: z.string() });
export type ConnectorsDto = z.infer<typeof ConnectorsDto>;

export const ProspectImportErrorDto = z.object({ row: z.number().int(), name: z.string().nullable(), column: z.string().nullable(), code: z.string(), message: z.string() });
export type ProspectImportErrorDto = z.infer<typeof ProspectImportErrorDto>;
export const ProspectImportJobDto = z.object({
  id: z.uuid(),
  mode: z.enum(["dry_run", "apply"]),
  status: z.enum(["valid", "invalid", "applied", "rejected"]),
  fileHash: z.string(),
  totals: z.object({ rows: z.number().int(), created: z.number().int(), updated: z.number().int(), unchanged: z.number().int(), errors: z.number().int() }),
  errors: z.array(ProspectImportErrorDto),
  errorsTruncated: z.boolean(),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
});
export type ProspectImportJobDto = z.infer<typeof ProspectImportJobDto>;
export const ProspectImportResultDto = ProspectImportJobDto.extend({
  rows: z.array(z.object({ row: z.number().int(), name: z.string().nullable(), action: z.enum(["create", "update", "unchanged", "error"]) })),
});
export type ProspectImportResultDto = z.infer<typeof ProspectImportResultDto>;
export const ProspectImportJobPageDto = z.object({ items: z.array(ProspectImportJobDto), nextCursor: z.uuid().nullable() });
export type ProspectImportJobPageDto = z.infer<typeof ProspectImportJobPageDto>;

export const AttributeDto = z.object({
  id: z.uuid(),
  key: z.string(),
  value: z.string(),
  confidence: z.enum(CONFIDENCES),
  source: z.enum(["manual", "csv_import", "openstreetmap"]),
  status: z.enum(["unverified", "verified", "rejected"]),
  /** True when another non-rejected value exists for the same key: a human must verify one. */
  conflict: z.boolean(),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
});
export type AttributeDto = z.infer<typeof AttributeDto>;
export const AttributeListDto = z.object({ items: z.array(AttributeDto) });
export type AttributeListDto = z.infer<typeof AttributeListDto>;

export const ScoringVersionDto = z.object({
  id: z.uuid(),
  version: z.number().int(),
  state: z.enum(["draft", "approved", "superseded"]),
  rules: z.array(ScoreRule),
  createdAt: z.iso.datetime(),
  approvedAt: z.iso.datetime().nullable(),
});
export type ScoringVersionDto = z.infer<typeof ScoringVersionDto>;
export const ScoringModelDto = z.object({ approved: ScoringVersionDto.nullable(), draft: ScoringVersionDto.nullable() });
export type ScoringModelDto = z.infer<typeof ScoringModelDto>;
export const ScoreBreakdownDto = z.object({ ruleId: z.string(), label: z.string(), matched: z.boolean(), points: z.number().int(), evidence: z.string().nullable() });
export type ScoreBreakdownDto = z.infer<typeof ScoreBreakdownDto>;
export const ScoreResultDto = z.object({ id: z.uuid(), prospectId: z.uuid(), modelVersion: z.number().int(), total: z.number().int(), breakdown: z.array(ScoreBreakdownDto), computedAt: z.iso.datetime() });
export type ScoreResultDto = z.infer<typeof ScoreResultDto>;
/** `stale` = the latest score was computed with a model version that is no longer the approved one. */
export const ProspectScoreDto = z.object({ result: ScoreResultDto.nullable(), stale: z.boolean() });
export type ProspectScoreDto = z.infer<typeof ProspectScoreDto>;
export const RecomputeDto = z.object({ computed: z.number().int(), skippedSuppressed: z.number().int(), modelVersion: z.number().int() });
export type RecomputeDto = z.infer<typeof RecomputeDto>;

export const LeadSettingsDto = z.object({ minScore: z.number().int().nullable() });
export type LeadSettingsDto = z.infer<typeof LeadSettingsDto>;
export const EvaluateLeadsDto = z.object({
  created: z.number().int(),
  alreadyOpen: z.number().int(),
  belowThreshold: z.number().int(),
  noScore: z.number().int(),
  suppressed: z.number().int(),
  previouslyRejected: z.number().int(),
});
export type EvaluateLeadsDto = z.infer<typeof EvaluateLeadsDto>;
export const LEAD_STATES = ["pending_review", "accepted", "rejected"] as const;
export const LeadDto = z.object({
  id: z.uuid(),
  prospect: z.object({ id: z.uuid(), name: z.string(), domain: z.string().nullable() }),
  origin: z.enum(["rule", "intent"]),
  state: z.enum(LEAD_STATES),
  minScore: z.number().int().nullable(),
  scoreTotal: z.number().int().nullable(),
  intentClass: z.string().nullable(),
  reviewNote: z.string().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type LeadDto = z.infer<typeof LeadDto>;
export const LeadPageDto = z.object({ items: z.array(LeadDto), nextCursor: z.uuid().nullable() });
export type LeadPageDto = z.infer<typeof LeadPageDto>;

export const INTENT_CLASSES = ["purchase", "quote", "info", "call", "future", "no_interest", "unsubscribe", "auto_reply", "irrelevant", "review"] as const;
export const IntentAssessmentDto = z.object({
  id: z.uuid(),
  prospectId: z.uuid(),
  class: z.enum(INTENT_CLASSES),
  ambiguous: z.boolean(),
  matched: z.array(z.object({ class: z.string(), phrase: z.string() })),
  classifierVersion: z.string(),
  excerpt: z.string(),
  createdAt: z.iso.datetime(),
  /** Side effects of this classification (unsubscribe always wins; positive intent opens a lead for HUMAN review). */
  effects: z.object({ suppressionCreated: z.boolean(), leadId: z.uuid().nullable() }),
});
export type IntentAssessmentDto = z.infer<typeof IntentAssessmentDto>;
export const IntentAssessmentListDto = z.object({ items: z.array(IntentAssessmentDto) });
export type IntentAssessmentListDto = z.infer<typeof IntentAssessmentListDto>;

export const OpportunityDto = z.object({
  id: z.uuid(),
  leadId: z.uuid(),
  prospect: z.object({ id: z.uuid(), name: z.string(), domain: z.string().nullable() }),
  title: z.string(),
  stage: z.enum(OPPORTUNITY_STAGES),
  ownerUserId: z.uuid().nullable(),
  ownerName: z.string().nullable(),
  assignedAt: z.iso.datetime().nullable(),
  expectedValue: z.string().nullable(),
  currency: z.string().nullable(),
  lossReason: z.string().nullable(),
  firstResponseDueAt: z.iso.datetime().nullable(),
  firstContactedAt: z.iso.datetime().nullable(),
  /** null when no SLA applies; true when first contact came after the deadline or the deadline passed without contact. */
  slaBreached: z.boolean().nullable(),
  closedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type OpportunityDto = z.infer<typeof OpportunityDto>;
export const TimelineItemDto = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stage"), at: z.iso.datetime(), by: z.string().nullable(), from: z.string().nullable(), to: z.string(), note: z.string().nullable() }),
  z.object({ kind: z.literal("note"), at: z.iso.datetime(), by: z.string().nullable(), noteKind: z.string(), body: z.string() }),
  z.object({ kind: z.literal("assignment"), at: z.iso.datetime(), by: z.string().nullable(), assignedTo: z.string().nullable(), strategy: z.string() }),
]);
export type TimelineItemDto = z.infer<typeof TimelineItemDto>;
export const OpportunityDetailDto = OpportunityDto.extend({ timeline: z.array(TimelineItemDto) });
export type OpportunityDetailDto = z.infer<typeof OpportunityDetailDto>;
export const OpportunityPageDto = z.object({ items: z.array(OpportunityDto), nextCursor: z.uuid().nullable() });
export type OpportunityPageDto = z.infer<typeof OpportunityPageDto>;
export const PipelineSummaryDto = z.object({ stages: z.record(z.string(), z.number().int()), total: z.number().int() });
export type PipelineSummaryDto = z.infer<typeof PipelineSummaryDto>;
export const RoutingSettingsDto = z.object({ strategy: z.enum(["manual", "round_robin"]), firstResponseSlaMinutes: z.number().int().nullable() });
export type RoutingSettingsDto = z.infer<typeof RoutingSettingsDto>;
export const PoolMemberDto = z.object({ userId: z.uuid(), displayName: z.string(), active: z.boolean(), maxOpen: z.number().int(), openCount: z.number().int(), lastAssignedAt: z.iso.datetime().nullable() });
export type PoolMemberDto = z.infer<typeof PoolMemberDto>;
export const PoolDto = z.object({ items: z.array(PoolMemberDto) });
export type PoolDto = z.infer<typeof PoolDto>;

export const QuoteLineDto = z.object({
  id: z.uuid(),
  position: z.number().int(),
  sku: z.string(),
  itemName: z.string(),
  itemVersion: z.number().int(),
  unit: z.string().nullable(),
  quantity: z.string(),
  unitPrice: z.string(),
  discountPercent: z.string(),
  gross: z.string(),
  discountAmount: z.string(),
  lineTotal: z.string(),
  /** The evidence the line was built from (see /catalog/evidence/resolve). */
  itemRef: z.string(),
  priceRef: z.string(),
});
export type QuoteLineDto = z.infer<typeof QuoteLineDto>;
export const QuoteDto = z.object({
  id: z.uuid(),
  number: z.number().int(),
  label: z.string(),
  opportunityId: z.uuid(),
  status: z.enum(QUOTE_STATUSES),
  priceListId: z.uuid(),
  currency: z.string(),
  validUntil: z.string().nullable(),
  taxRate: z.string().nullable(),
  notes: z.string().nullable(),
  subtotal: z.string(),
  discountTotal: z.string(),
  taxTotal: z.string(),
  total: z.string(),
  /** Some line has a discount above the organization's limit, so an org_admin must approve it before sending. */
  requiresDiscountApproval: z.boolean(),
  discountApproved: z.boolean(),
  sentAt: z.iso.datetime().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type QuoteDto = z.infer<typeof QuoteDto>;
export const QuoteDetailDto = QuoteDto.extend({ lines: z.array(QuoteLineDto) });
export type QuoteDetailDto = z.infer<typeof QuoteDetailDto>;
export const QuotePageDto = z.object({ items: z.array(QuoteDto), nextCursor: z.uuid().nullable() });
export type QuotePageDto = z.infer<typeof QuotePageDto>;
export const QuoteSettingsDto = z.object({ maxDiscountPercent: z.string() });
export type QuoteSettingsDto = z.infer<typeof QuoteSettingsDto>;
export const SaleDto = z.object({
  id: z.uuid(),
  quoteId: z.uuid(),
  quoteNumber: z.number().int(),
  opportunityId: z.uuid(),
  leadId: z.uuid(),
  prospectId: z.uuid(),
  total: z.string(),
  currency: z.string(),
  closedAt: z.iso.datetime(),
});
export type SaleDto = z.infer<typeof SaleDto>;
export const SalePageDto = z.object({ items: z.array(SaleDto), nextCursor: z.uuid().nullable() });
export type SalePageDto = z.infer<typeof SalePageDto>;

export const AnalyticsOverviewDto = z.object({
  window: z.object({ from: z.string(), to: z.string(), timezone: z.literal("UTC") }),
  /** Every metric is defined here, in plain words, next to its number. */
  definitions: z.array(z.object({ id: z.string(), label: z.string(), definition: z.string() })),
  funnel: z.array(z.object({ id: z.string(), label: z.string(), count: z.number().int(), conversionFromPrevious: z.number().nullable() })),
  leads: z.object({ byOrigin: z.record(z.string(), z.number().int()), byState: z.record(z.string(), z.number().int()) }),
  pipeline: z.object({ stages: z.record(z.string(), z.number().int()), open: z.number().int() }),
  transitions: z.array(z.object({ from: z.string().nullable(), to: z.string(), count: z.number().int() })),
  sla: z.object({ measured: z.number().int(), breached: z.number().int(), breachRate: z.number().nullable(), avgFirstResponseMinutes: z.number().nullable() }),
  outcomes: z.object({ won: z.number().int(), lost: z.number().int(), winRate: z.number().nullable(), lostReasons: z.array(z.object({ reason: z.string(), count: z.number().int() })) }),
  sales: z.array(z.object({ currency: z.string(), count: z.number().int(), total: z.string(), average: z.string() })),
  /** Sales are reconciled against the totals of the accepted quotes that produced them. */
  reconciliation: z.array(z.object({ currency: z.string(), salesTotal: z.string(), quotesTotal: z.string(), matches: z.boolean() })),
});
export type AnalyticsOverviewDto = z.infer<typeof AnalyticsOverviewDto>;

/* ---------- Attribution & cohorts (F11) ---------- */
const attrWindow = { from: z.iso.date().optional(), to: z.iso.date().optional() };
const attrValid = (v: { from?: string | undefined; to?: string | undefined }) => {
  if (!v.from || !v.to) return true;
  const days = (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000;
  return days >= 0 && days <= 365;
};
/** `lookbackDays`: how far before a conversion a sent campaign email still counts as its last touch (default 30). */
export const AttributionQuery = z
  .strictObject({ ...attrWindow, lookbackDays: z.coerce.number().int().min(1).max(365).default(30) })
  .refine(attrValid, { message: "from must not be after to, and the window is at most 366 days", path: ["to"] });
export type AttributionQuery = z.infer<typeof AttributionQuery>;
export const CohortsQuery = z.strictObject(attrWindow).refine(attrValid, { message: "from must not be after to, and the window is at most 366 days", path: ["to"] });
export type CohortsQuery = z.infer<typeof CohortsQuery>;
const AttrSalesByCurrency = z.array(z.object({ currency: z.string(), count: z.number().int(), total: z.string() }));
export const AttributionReportDto = z.object({
  window: z.object({ from: z.string(), to: z.string(), timezone: z.literal("UTC") }),
  model: z.object({ id: z.literal("last_touch_sent_email"), lookbackDays: z.number().int(), definition: z.string() }),
  campaigns: z.array(
    z.object({
      campaignId: z.string(), name: z.string(), sent: z.number().int(), prospectsReached: z.number().int(),
      leads: z.number().int(), opportunities: z.number().int(), sales: z.number().int(), salesByCurrency: AttrSalesByCurrency,
    }),
  ),
  unattributed: z.object({ leads: z.number().int(), opportunities: z.number().int(), sales: z.number().int(), salesByCurrency: AttrSalesByCurrency }),
  /** attributed + unattributed equals the analytics overview funnel for the same window. */
  totals: z.object({ leads: z.number().int(), opportunities: z.number().int(), sales: z.number().int(), salesByCurrency: AttrSalesByCurrency }),
});
export type AttributionReportDto = z.infer<typeof AttributionReportDto>;
const CohortStep = z.object({ ever: z.number().int(), within30d: z.number().int(), within60d: z.number().int(), within90d: z.number().int() });
export const CohortsReportDto = z.object({
  window: z.object({ from: z.string(), to: z.string(), timezone: z.literal("UTC") }),
  definition: z.string(),
  cohorts: z.array(z.object({ month: z.string(), prospects: z.number().int(), leads: CohortStep, opportunities: CohortStep, sales: CohortStep })),
  /** Sum of cohort sizes equals the analytics prospects count for the same window. */
  totalProspects: z.number().int(),
});
export type CohortsReportDto = z.infer<typeof CohortsReportDto>;
export const AnalyticsEventDto = z.object({ id: z.uuid(), type: z.string(), at: z.iso.datetime(), title: z.string(), path: z.string().nullable() });
export type AnalyticsEventDto = z.infer<typeof AnalyticsEventDto>;
export const AnalyticsEventPageDto = z.object({ items: z.array(AnalyticsEventDto), nextCursor: z.uuid().nullable() });
export type AnalyticsEventPageDto = z.infer<typeof AnalyticsEventPageDto>;

export const ChangePasswordRequest = z.strictObject({ currentPassword: z.string().min(1).max(128), newPassword: password });
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;
export const ChangedPasswordDto = z.object({ revokedSessions: z.number().int().nonnegative() });
export type ChangedPasswordDto = z.infer<typeof ChangedPasswordDto>;
export const SessionInfoDto = z.object({ id: z.uuid(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), current: z.boolean() });
export type SessionInfoDto = z.infer<typeof SessionInfoDto>;
export const SessionInfoListDto = z.object({ items: z.array(SessionInfoDto) });
export type SessionInfoListDto = z.infer<typeof SessionInfoListDto>;

export const MyOrganizationDto = z.object({ id: z.uuid(), name: z.string(), slug: z.string(), role: roleSchema, current: z.boolean() });
export type MyOrganizationDto = z.infer<typeof MyOrganizationDto>;
export const MyOrganizationsDto = z.object({ items: z.array(MyOrganizationDto) });
export type MyOrganizationsDto = z.infer<typeof MyOrganizationsDto>;

/** Uniform error envelope for every non-2xx response. `details` is null unless the error carries structured data. */
export const ProblemDto = z.object({ code: z.string(), message: z.string(), details: z.unknown().nullable(), request_id: z.uuid() });
export type ProblemDto = z.infer<typeof ProblemDto>;

export const ERROR_CODES = [
  "BAD_REQUEST",
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "IDEMPOTENCY_KEY_REUSED",
  "IDEMPOTENCY_IN_PROGRESS",
  "RATE_LIMITED",
  "UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ProspectMergeDto = z.object({
  id: z.uuid(),
  survivorId: z.uuid(),
  duplicateId: z.uuid(),
  reason: z.string(),
  mergedBy: z.uuid(),
  mergedAt: z.iso.datetime(),
  revertedBy: z.uuid().nullable(),
  revertedAt: z.iso.datetime().nullable(),
});
export type ProspectMergeDto = z.infer<typeof ProspectMergeDto>;
export const ProspectMergeListDto = z.object({ items: z.array(ProspectMergeDto) });
export type ProspectMergeListDto = z.infer<typeof ProspectMergeListDto>;

/* ---------- P12-04 privacy: retention policy and data-subject requests ---------- */
/** Only classes that are safe to purge. Never: audit, consent ledger, suppressions, accepted quotes/sales (legal evidence). */
export const RETENTION_CLASSES = ["import_jobs", "sessions", "invitations", "jobs"] as const;
/** Owner-decided defaults (days) applied while an organization has no policy of its own for the class. Mirrors SQL retention_default_days(). */
export const RETENTION_DEFAULT_DAYS = { import_jobs: 90, sessions: 30, invitations: 30, jobs: 30 } as const satisfies Record<(typeof RETENTION_CLASSES)[number], number>;
export const RetentionClass = z.enum(RETENTION_CLASSES);
export type RetentionClass = z.infer<typeof RetentionClass>;
/** retentionDays: 30..3650, or 0 to disable the purge of that class. */
export const RetentionPolicyEntry = z.strictObject({ dataClass: RetentionClass, retentionDays: z.number().int().min(0).max(3650).refine((n) => n === 0 || n >= 30, "Use 0 (disabled) or 30..3650 days") });
export const SetRetentionRequest = z.strictObject({ policies: z.array(RetentionPolicyEntry).min(1).max(RETENTION_CLASSES.length) });
export type SetRetentionRequest = z.infer<typeof SetRetentionRequest>;
export const RetentionPolicyDto = z.object({
  policies: z.array(z.object({ dataClass: RetentionClass, retentionDays: z.number().int(), updatedBy: z.uuid(), updatedAt: z.iso.datetime() })),
  /** Classes that can be configured; without an explicit policy the default applies. */
  available: z.array(RetentionClass),
  /** What the purge will actually use per class: the organization policy or the default. retentionDays 0 = disabled. */
  effective: z.array(z.object({ dataClass: RetentionClass, retentionDays: z.number().int(), source: z.enum(["policy", "default"]) })),
});
export type RetentionPolicyDto = z.infer<typeof RetentionPolicyDto>;
export const RetentionRunRequest = z.strictObject({ dryRun: z.boolean().default(true) });
export type RetentionRunRequest = z.infer<typeof RetentionRunRequest>;
export const RetentionRunDto = z.object({
  dryRun: z.boolean(),
  ranAt: z.iso.datetime(),
  classes: z.array(z.object({ dataClass: RetentionClass, retentionDays: z.number().int(), source: z.enum(["policy", "default"]), cutoff: z.iso.datetime(), eligible: z.number().int(), deleted: z.number().int() })),
  /** Classes disabled by the organization (retentionDays 0): untouched. */
  skipped: z.array(RetentionClass),
});
export type RetentionRunDto = z.infer<typeof RetentionRunDto>;

export const PRIVACY_KINDS = ["access", "restrict", "erase"] as const;
export const CreatePrivacyRequest = z.strictObject({ contactId: z.uuid(), kind: z.enum(PRIVACY_KINDS) });
export type CreatePrivacyRequest = z.infer<typeof CreatePrivacyRequest>;
export const PrivacyNoteRequest = z.strictObject({ note: text(500).min(3) });
export type PrivacyNoteRequest = z.infer<typeof PrivacyNoteRequest>;
export const PrivacyListQuery = z.strictObject({ status: z.enum(["open", "completed", "rejected"]).optional() });
export type PrivacyListQuery = z.infer<typeof PrivacyListQuery>;
export const PrivacyRequestDto = z.object({
  id: z.uuid(),
  contactId: z.uuid(),
  kind: z.enum(PRIVACY_KINDS),
  status: z.enum(["open", "completed", "rejected"]),
  requestedBy: z.uuid(),
  requestedAt: z.iso.datetime(),
  /** Informational (30 days by default); nothing happens automatically when it passes. */
  dueAt: z.iso.datetime(),
  completedBy: z.uuid().nullable(),
  completedAt: z.iso.datetime().nullable(),
  note: z.string().nullable(),
  /** Only on the response that completes an `access` request: the data package (no secrets). Not stored. */
  accessPackage: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type PrivacyRequestDto = z.infer<typeof PrivacyRequestDto>;
export const PrivacyRequestListDto = z.object({ items: z.array(PrivacyRequestDto) });
export type PrivacyRequestListDto = z.infer<typeof PrivacyRequestListDto>;

/* ---------- personalised message drafts (P7-03): content for a human to review, never a send ---------- */
export const DRAFT_CHANNELS = ["email", "whatsapp"] as const;
export const DRAFT_STATUSES = ["pending_review", "approved", "rejected"] as const;
export const DRAFT_LIMITS = { email: { subjectMax: 200, bodyMax: 5000 }, whatsapp: { bodyMax: 1024 } } as const;
const noNul = (v: string) => !v.includes("\u0000");
export const CreateDraftRequest = z
  .strictObject({
    contactId: z.uuid(),
    channel: z.enum(DRAFT_CHANNELS),
    subject: z.string().trim().min(1).max(DRAFT_LIMITS.email.subjectMax).refine(noNul, "NUL is not allowed").optional(),
    body: z.string().trim().min(1).max(DRAFT_LIMITS.email.bodyMax).refine(noNul, "NUL is not allowed"),
    evidenceRefs: z.array(z.string().min(1).max(100)).max(20),
  })
  .superRefine((v, ctx) => {
    if (v.channel === "email" && v.subject === undefined) ctx.addIssue({ code: "custom", path: ["subject"], message: "an email draft needs a subject" });
    if (v.channel === "whatsapp" && v.subject !== undefined) ctx.addIssue({ code: "custom", path: ["subject"], message: "a WhatsApp draft has no subject" });
    if (v.channel === "whatsapp" && v.body.length > DRAFT_LIMITS.whatsapp.bodyMax) ctx.addIssue({ code: "custom", path: ["body"], message: `a WhatsApp body is at most ${DRAFT_LIMITS.whatsapp.bodyMax} characters` });
  });
export type CreateDraftRequest = z.infer<typeof CreateDraftRequest>;
export const DraftListQuery = z.strictObject({
  status: z.enum(DRAFT_STATUSES).optional(),
  contactId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});
export type DraftListQuery = z.infer<typeof DraftListQuery>;
export const RejectDraftRequest = z.strictObject({ note: z.string().trim().min(1).max(500).refine(noNul, "NUL is not allowed") });
export type RejectDraftRequest = z.infer<typeof RejectDraftRequest>;
export const MessageDraftDto = z.object({
  id: z.uuid(),
  contactId: z.uuid(),
  channel: z.enum(DRAFT_CHANNELS),
  subject: z.string().nullable(),
  body: z.string(),
  evidenceRefs: z.array(z.string()),
  status: z.enum(DRAFT_STATUSES),
  authorKind: z.enum(["human", "mcp"]),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
  decidedBy: z.uuid().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  decisionNote: z.string().nullable(),
});
export type MessageDraftDto = z.infer<typeof MessageDraftDto>;
export const MessageDraftPageDto = z.object({ items: z.array(MessageDraftDto), nextCursor: z.uuid().nullable() });
export type MessageDraftPageDto = z.infer<typeof MessageDraftPageDto>;
/** Delivery of an approved email draft. `none` = nobody asked to send it. Only the worker sends. */
export const DRAFT_DELIVERY_STATES = ["none", "queued", "sent", "failed", "skipped"] as const;
export const DraftDeliveryDto = z.object({
  draftId: z.uuid(),
  state: z.enum(DRAFT_DELIVERY_STATES),
  skipReason: z.string().nullable(),
  provider: z.string().nullable(),
  attemptedAt: z.iso.datetime().nullable(),
});
export type DraftDeliveryDto = z.infer<typeof DraftDeliveryDto>;
const channelEligibility = z.object({ eligible: z.boolean(), reasons: z.array(z.string()) });
export const OutreachContextDto = z.object({
  contactId: z.uuid(),
  channels: z.object({ email: channelEligibility, whatsapp: channelEligibility }),
  contact: z.object({ displayName: z.string().nullable(), addressMasked: z.string(), channel: z.enum(DRAFT_CHANNELS), source: z.string() }),
  prospect: z.object({ name: z.string(), industry: z.string().nullable(), country: z.string().nullable(), city: z.string().nullable() }),
  evidence: z.array(z.object({ ref: z.string(), kind: z.string(), summary: z.string() })),
  constraints: z.object({
    email: z.object({ subjectMax: z.number().int(), bodyMax: z.number().int() }),
    whatsapp: z.object({ bodyMax: z.number().int(), templateOnly: z.boolean(), note: z.string() }),
  }),
});
export type OutreachContextDto = z.infer<typeof OutreachContextDto>;

/* ---------- F7 sequences: chained steps + sending window per campaign (sandbox channel only) ---------- */
const seqNoNul = (v: string) => !v.includes("\u0000");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Use HH:MM");
export const SEQUENCE_STOP_REASONS = [...EXCLUSION_REASONS, "campaign_closed"] as const;
export const SEQUENCE_ENROLLMENT_STATES = ["active", "completed", "stopped"] as const;
export const SequenceStepInput = z.strictObject({
  delayHours: z.number().int().min(0).max(2160),
  subject: z.string().trim().min(1).max(200).refine(seqNoNul, "NUL is not allowed"),
  body: z.string().trim().min(1).max(5000).refine(seqNoNul, "NUL is not allowed"),
});
export const SaveSequenceRequest = z
  .strictObject({
    timezone: z.string().min(1).max(64).refine((tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } }, "Unknown IANA time zone"),
    windowStart: hhmm,
    windowEnd: hhmm,
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    steps: z.array(SequenceStepInput).min(1).max(10),
  })
  .superRefine((v, ctx) => {
    const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    if (m(v.windowEnd) <= m(v.windowStart)) ctx.addIssue({ code: "custom", path: ["windowEnd"], message: "The window must end after it starts" });
    if (new Set(v.weekdays).size !== v.weekdays.length) ctx.addIssue({ code: "custom", path: ["weekdays"], message: "Duplicate weekdays" });
    if ((v.steps[0]?.delayHours ?? 0) !== 0) ctx.addIssue({ code: "custom", path: ["steps", 0, "delayHours"], message: "The first step has no delay" });
  });
export type SaveSequenceRequest = z.infer<typeof SaveSequenceRequest>;
export const SequenceDto = z.object({
  campaignId: z.uuid(),
  configured: z.boolean(),
  timezone: z.string().nullable(),
  windowStart: z.string().nullable(),
  windowEnd: z.string().nullable(),
  weekdays: z.array(z.number().int()),
  steps: z.array(z.object({ stepNo: z.number().int(), delayHours: z.number().int(), subject: z.string(), body: z.string() })),
});
export type SequenceDto = z.infer<typeof SequenceDto>;
export const EnrollResultDto = z.object({
  enrolled: z.number().int(),
  alreadyEnrolled: z.number().int(),
  excluded: z.object(Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, z.number().int()])) as Record<(typeof EXCLUSION_REASONS)[number], z.ZodNumber>),
  firstDueAt: z.iso.datetime().nullable(),
});
export type EnrollResultDto = z.infer<typeof EnrollResultDto>;
export const RunDueRequest = z.strictObject({ limit: z.number().int().min(1).max(200).default(50) });
export type RunDueRequest = z.infer<typeof RunDueRequest>;
export const RunDueResultDto = z.object({
  processed: z.number().int(),
  sent: z.number().int(),
  deferred: z.number().int(),
  completed: z.number().int(),
  stopped: z.record(z.string(), z.number().int()),
  nextDueAt: z.iso.datetime().nullable(),
});
export type RunDueResultDto = z.infer<typeof RunDueResultDto>;
export const EnrollmentListQuery = z.strictObject({
  state: z.enum(["all", ...SEQUENCE_ENROLLMENT_STATES]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});
export type EnrollmentListQuery = z.infer<typeof EnrollmentListQuery>;
export const EnrollmentDto = z.object({
  id: z.uuid(),
  contactId: z.uuid(),
  address: z.string(),
  state: z.enum(SEQUENCE_ENROLLMENT_STATES),
  stopReason: z.string().nullable(),
  nextStep: z.number().int(),
  nextDueAt: z.iso.datetime().nullable(),
  deliveries: z.array(z.object({ stepNo: z.number().int(), providerMessageId: z.string(), sentAt: z.iso.datetime() })),
});
export type EnrollmentDto = z.infer<typeof EnrollmentDto>;
export const EnrollmentPageDto = z.object({ items: z.array(EnrollmentDto), nextCursor: z.uuid().nullable() });
export type EnrollmentPageDto = z.infer<typeof EnrollmentPageDto>;

/* ---------- Worker job queue (PostgreSQL-backed; admin view of retries and the dead-letter queue) ---------- */
export const JOB_STATES = ["queued", "running", "succeeded", "failed", "dead"] as const;
export type JobState = (typeof JOB_STATES)[number];
export const JOB_TYPES = ["sequence.run_due", "notifications.scan_due", "retention.purge", "campaign.dispatch", "draft.send_queued", "prospects.expire_due", "notifications.send_email"] as const;
export type JobType = (typeof JOB_TYPES)[number];
export const JobListQuery = z.strictObject({
  state: z.enum(["all", ...JOB_STATES]).default("dead"),
  type: z.enum(JOB_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});
export type JobListQuery = z.infer<typeof JobListQuery>;
export const JobDto = z.object({
  id: z.uuid(),
  type: z.enum(JOB_TYPES),
  state: z.enum(JOB_STATES),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  runAfter: z.iso.datetime(),
  /** Redacted (no addresses, tokens or secrets) and truncated. */
  lastError: z.string().nullable(),
  lastErrorAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type JobDto = z.infer<typeof JobDto>;
export const JobPageDto = z.object({ items: z.array(JobDto), nextCursor: z.uuid().nullable() });
export type JobPageDto = z.infer<typeof JobPageDto>;
export const JobStatsDto = z.object({ byState: z.record(z.enum(JOB_STATES), z.number().int()) });
export type JobStatsDto = z.infer<typeof JobStatsDto>;

// --- Per-organization SMTP (each tenant sends with its own mailbox) ---
export const SMTP_PORTS = [25, 465, 587, 2525] as const;
const smtpHost = z.string().trim().toLowerCase().max(253).regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^localhost$|^\d{1,3}(\.\d{1,3}){3}$/, "a host name such as smtp.example.com");
const smtpPort = z.number().int().refine((v) => (SMTP_PORTS as readonly number[]).includes(v), "one of 25, 465, 587, 2525");
const headerSafe = (v: string) => !/[\u0000-\u001f\u007f<>"]/.test(v);
/** PUT replaces the settings. `password` may be omitted only to keep the stored one, and never when host or username change. */
export const UpdateEmailSettingsRequest = z.strictObject({
  host: smtpHost,
  port: smtpPort,
  secure: z.boolean(),
  username: z.string().trim().min(1).max(254).refine(headerSafe, "no control characters"),
  password: z.string().min(1).max(256).optional(),
  fromName: text(120).refine(headerSafe, "no control characters or quotes").nullish(),
  fromEmail: email,
  replyTo: email.nullish(),
});
export type UpdateEmailSettingsRequest = z.infer<typeof UpdateEmailSettingsRequest>;
/** The password is never returned: only whether one is stored. */
export const EmailSettingsDto = z.object({
  configured: z.boolean(),
  host: z.string().nullable(),
  port: z.number().int().nullable(),
  secure: z.boolean().nullable(),
  username: z.string().nullable(),
  hasPassword: z.boolean(),
  fromName: z.string().nullable(),
  fromEmail: z.string().nullable(),
  replyTo: z.string().nullable(),
  verifiedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime().nullable(),
});
export type EmailSettingsDto = z.infer<typeof EmailSettingsDto>;
/** Without `sendTo` only the connection and login are checked; with it one test message is sent to that address. */
export const TestEmailSettingsRequest = z.strictObject({ sendTo: email.optional() });
export type TestEmailSettingsRequest = z.infer<typeof TestEmailSettingsRequest>;
export const EMAIL_TEST_FAILURES = ["auth_failed", "connection_failed", "tls_failed", "host_not_allowed", "rejected", "unknown"] as const;
export const EmailSettingsTestDto = z.object({ ok: z.boolean(), sent: z.boolean(), failure: z.enum(EMAIL_TEST_FAILURES).nullable(), verifiedAt: z.iso.datetime().nullable() });
export type EmailSettingsTestDto = z.infer<typeof EmailSettingsTestDto>;
export * from "./ai-usage.js";
export * from "./lifecycle.js";
export * from "./notification-email.js";
export * from "./platform-admin.js";
export * from "./roles.js";
export * from "./whatsapp-manual.js";

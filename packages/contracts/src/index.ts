import { z } from "zod";

/** Shared contracts (API v1). Request schemas are strict: unknown keys (e.g. `organization_id`) are rejected, never trusted. */
export type HealthStatus = Readonly<{
  status: "ok";
  service: "api";
}>;

/* ---------- RBAC ---------- */

export const MEMBERSHIP_ROLES = ["org_admin", "campaign_manager", "sales_manager", "seller", "analyst", "viewer"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const PERMISSIONS = ["organization:read", "organization:update", "members:read", "members:manage", "audit:read", "catalog:read", "catalog:manage", "catalog:approve"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Single source of truth for role -> permission. `saas_admin` is platform-level and intentionally absent (ADR-011). */
export const ROLE_PERMISSIONS: Readonly<Record<MembershipRole, readonly Permission[]>> = {
  org_admin: PERMISSIONS,
  campaign_manager: ["organization:read", "members:read", "catalog:read"],
  sales_manager: ["organization:read", "members:read", "catalog:read", "catalog:manage"],
  seller: ["organization:read", "catalog:read"],
  analyst: ["organization:read", "catalog:read"],
  viewer: ["organization:read", "catalog:read"],
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
  "INTERNAL_ERROR",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

import { z } from "zod";

/** Shared contracts (API v1). Request schemas are strict: unknown keys (e.g. `organization_id`) are rejected, never trusted. */
export type HealthStatus = Readonly<{
  status: "ok";
  service: "api";
}>;

/* ---------- RBAC ---------- */

export const MEMBERSHIP_ROLES = ["org_admin", "campaign_manager", "sales_manager", "seller", "analyst", "viewer"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const PERMISSIONS = ["organization:read", "organization:update", "members:read", "members:manage", "audit:read"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Single source of truth for role -> permission. `saas_admin` is platform-level and intentionally absent (ADR-011). */
export const ROLE_PERMISSIONS: Readonly<Record<MembershipRole, readonly Permission[]>> = {
  org_admin: PERMISSIONS,
  campaign_manager: ["organization:read", "members:read"],
  sales_manager: ["organization:read", "members:read"],
  seller: ["organization:read"],
  analyst: ["organization:read"],
  viewer: ["organization:read"],
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

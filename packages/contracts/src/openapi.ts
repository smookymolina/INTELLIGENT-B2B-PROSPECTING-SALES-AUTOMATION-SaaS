import { z, type ZodType } from "zod";
import * as C from "./index.js";

/**
 * Executable API contract. `OPERATIONS` is the single list of public routes; the OpenAPI document is generated from it and
 * from the zod schemas that the API itself validates with. Parity with the real NestJS routes is enforced by an integration test,
 * and the committed `docs/api/openapi.v1.json` must equal the generated output (run `npm run openapi:generate`).
 */
export const API_VERSION = "1.0.0";

type Method = "get" | "post" | "patch" | "delete";
export type Operation = Readonly<{
  method: Method;
  /** OpenAPI style path, relative to /v1 (e.g. `/memberships/{id}`). */
  path: string;
  id: string;
  summary: string;
  tag: string;
  public?: boolean;
  permission?: C.Permission;
  body?: ZodType;
  query?: ZodType;
  pathParams?: readonly string[];
  idempotent?: boolean;
  success: Readonly<{ status: number; schema?: ZodType; description: string }>;
  errors: readonly number[];
}>;

const ERR_DESC: Record<number, string> = {
  400: "Validation failed (VALIDATION_FAILED)",
  401: "Missing, invalid, expired or revoked credentials (UNAUTHENTICATED)",
  403: "Authenticated but not allowed (FORBIDDEN)",
  404: "Not found in the caller's organization (NOT_FOUND)",
  409: "Conflict (CONFLICT / IDEMPOTENCY_IN_PROGRESS)",
  422: "Idempotency-Key reused with a different request (IDEMPOTENCY_KEY_REUSED)",
  429: "Too many attempts (RATE_LIMITED); see Retry-After",
};

export const OPERATIONS: readonly Operation[] = [
  { method: "get", path: "/health", id: "getHealth", summary: "Liveness probe", tag: "Health", public: true, success: { status: 200, description: "Service is up" }, errors: [] },
  {
    method: "post", path: "/auth/register", id: "register", summary: "Create user, organization and first org_admin session", tag: "Auth", public: true,
    body: C.RegisterRequest, idempotent: true, success: { status: 201, schema: C.SessionDto, description: "Session opened" }, errors: [400, 409, 422],
  },
  {
    method: "post", path: "/auth/login", id: "login", summary: "Open a session", tag: "Auth", public: true,
    body: C.LoginRequest, success: { status: 200, schema: C.SessionDto, description: "Session opened" }, errors: [400, 401, 403, 429],
  },
  { method: "post", path: "/auth/logout", id: "logout", summary: "Revoke the current session", tag: "Auth", success: { status: 204, description: "Session revoked" }, errors: [401] },
  {
    method: "post", path: "/auth/switch-organization", id: "switchOrganization", summary: "Open a session in another organization where the caller has an active membership (current session is revoked)", tag: "Auth",
    body: C.SwitchOrganizationRequest, success: { status: 200, schema: C.SessionDto, description: "New session" }, errors: [400, 401, 404],
  },
  { method: "get", path: "/me", id: "getMe", summary: "Current identity, organization, role and permissions", tag: "Auth", success: { status: 200, schema: C.MeDto, description: "Identity" }, errors: [401] },
  {
    method: "get", path: "/organization", id: "getOrganization", summary: "The caller's organization", tag: "Organization", permission: "organization:read",
    success: { status: 200, schema: C.OrganizationDto, description: "Organization" }, errors: [401, 403, 404],
  },
  {
    method: "patch", path: "/organization", id: "updateOrganization", summary: "Rename the caller's organization", tag: "Organization", permission: "organization:update",
    body: C.UpdateOrganizationRequest, success: { status: 200, schema: C.OrganizationDto, description: "Updated" }, errors: [400, 401, 403, 404],
  },
  {
    method: "get", path: "/memberships", id: "listMemberships", summary: "Members of the caller's organization", tag: "Memberships", permission: "members:read",
    success: { status: 200, schema: z.array(C.MemberDto), description: "Members" }, errors: [401, 403],
  },
  {
    method: "patch", path: "/memberships/{id}", id: "updateMembership", summary: "Change a member's role", tag: "Memberships", permission: "members:manage",
    pathParams: ["id"], body: C.UpdateMemberRequest, success: { status: 200, schema: C.MemberDto, description: "Updated" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "delete", path: "/memberships/{id}", id: "removeMembership", summary: "Remove a member", tag: "Memberships", permission: "members:manage",
    pathParams: ["id"], success: { status: 204, description: "Removed" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/invitations", id: "createInvitation", summary: "Offer a membership (does NOT create one; token returned once)", tag: "Invitations", permission: "members:manage",
    body: C.CreateInvitationRequest, idempotent: true, success: { status: 201, schema: C.InvitationCreatedDto, description: "Invitation created" }, errors: [400, 401, 403, 409, 422],
  },
  {
    method: "get", path: "/invitations", id: "listInvitations", summary: "Pending invitations of the caller's organization", tag: "Invitations", permission: "members:manage",
    success: { status: 200, schema: z.array(C.InvitationDto), description: "Pending invitations" }, errors: [401, 403],
  },
  {
    method: "delete", path: "/invitations/{id}", id: "revokeInvitation", summary: "Revoke a pending invitation", tag: "Invitations", permission: "members:manage",
    pathParams: ["id"], success: { status: 204, description: "Revoked" }, errors: [400, 401, 403, 404],
  },
  {
    method: "post", path: "/invitations/accept", id: "acceptInvitation", summary: "Accept an invitation as the authenticated user whose email matches", tag: "Invitations",
    body: C.AcceptInvitationRequest, success: { status: 200, schema: C.AcceptedInvitationDto, description: "Membership created (or already present)" }, errors: [400, 401, 404],
  },
  {
    method: "get", path: "/audit-events", id: "listAuditEvents", summary: "Most recent audit events of the caller's organization", tag: "Audit", permission: "audit:read",
    query: C.AuditQuery, success: { status: 200, schema: z.array(C.AuditEventDto), description: "Events" }, errors: [400, 401, 403],
  },
];

type Json = Record<string, unknown>;
const toSchema = (schema: ZodType, io: "input" | "output"): Json => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Json;
  return rest;
};

export function buildOpenApi(operations: readonly Operation[] = OPERATIONS): Json {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of operations) {
    const parameters: Json[] = [];
    for (const name of op.pathParams ?? []) parameters.push({ name, in: "path", required: true, schema: toSchema(C.UuidParam, "input") });
    if (op.query) {
      const json = toSchema(op.query, "input") as { properties?: Record<string, Json>; required?: string[] };
      for (const [name, schema] of Object.entries(json.properties ?? {})) parameters.push({ name, in: "query", required: json.required?.includes(name) ?? false, schema });
    }
    if (op.idempotent) parameters.push({ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", pattern: "^[A-Za-z0-9_.:-]{8,128}$" } });

    const responses: Record<string, unknown> = {
      [String(op.success.status)]: {
        description: op.success.description,
        headers: { "X-Request-Id": { $ref: "#/components/headers/XRequestId" } },
        ...(op.success.schema ? { content: { "application/json": { schema: toSchema(op.success.schema, "output") } } } : {}),
      },
    };
    for (const status of [...op.errors, 500].sort()) {
      responses[String(status)] = status === 500
        ? { $ref: "#/components/responses/InternalError" }
        : { description: ERR_DESC[status] ?? "Error", headers: { "X-Request-Id": { $ref: "#/components/headers/XRequestId" }, ...(status === 429 ? { "Retry-After": { schema: { type: "integer" } } } : {}) }, content: { "application/json": { schema: { $ref: "#/components/schemas/Problem" } } } };
    }

    (paths[op.path] ??= {})[op.method] = {
      operationId: op.id,
      summary: op.summary,
      tags: [op.tag],
      security: op.public ? [] : [{ bearerAuth: [] }],
      ...(op.permission ? { "x-required-permission": op.permission } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(op.body ? { requestBody: { required: true, content: { "application/json": { schema: toSchema(op.body, "input") } } } } : {}),
      responses,
    };
  }

  return {
    openapi: "3.1.0",
    info: { title: "Intelligent B2B Prospecting API", version: API_VERSION, description: "Contract for /v1. Tenant is derived from the session; clients never send organization ids." },
    servers: [{ url: "/v1" }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      headers: { XRequestId: { description: "Server-generated request id, also present in every error body", schema: { type: "string", format: "uuid" } } },
      schemas: { Problem: toSchema(C.ProblemDto, "output") },
      responses: {
        InternalError: { description: "Unexpected error (INTERNAL_ERROR)", headers: { "X-Request-Id": { $ref: "#/components/headers/XRequestId" } }, content: { "application/json": { schema: { $ref: "#/components/schemas/Problem" } } } },
      },
    },
  };
}

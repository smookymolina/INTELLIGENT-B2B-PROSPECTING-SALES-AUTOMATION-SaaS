import { z, type ZodType } from "zod";
import * as C from "./index.js";

/**
 * Executable API contract. `OPERATIONS` is the single list of public routes; the OpenAPI document is generated from it and
 * from the zod schemas that the API itself validates with. Parity with the real NestJS routes is enforced by an integration test,
 * and the committed `docs/api/openapi.v1.json` must equal the generated output (run `npm run openapi:generate`).
 */
export const API_VERSION = "1.0.0";

type Method = "get" | "post" | "put" | "patch" | "delete";
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
  413: "Request body too large",
  422: "Idempotency-Key reused with a different request (IDEMPOTENCY_KEY_REUSED)",
  429: "Too many attempts (RATE_LIMITED); see Retry-After",
  503: "Service unavailable (UNAVAILABLE); no detail is disclosed",
};

export const OPERATIONS: readonly Operation[] = [
  { method: "get", path: "/health", id: "getHealth", summary: "Liveness probe", tag: "Health", public: true, success: { status: 200, description: "Service is up" }, errors: [] },
  { method: "get", path: "/health/ready", id: "getReadiness", summary: "Readiness probe (the database answers); 503 without detail otherwise", tag: "Health", public: true, success: { status: 200, description: "Ready" }, errors: [503] },
  { method: "get", path: "/health/metrics", id: "getMetrics", summary: "Prometheus metrics (text/plain). 404 unless METRICS_TOKEN is configured and sent as a Bearer token; no tenant data", tag: "Health", public: true, success: { status: 200, description: "Metrics in Prometheus text format" }, errors: [404] },
  {
    method: "get", path: "/analytics/events/export", id: "exportAnalyticsEvents", summary: "CSV of the records behind one metric (formula-safe, capped; X-Export-Truncated when capped; audited)", tag: "Analytics", permission: "analytics:read",
    query: C.AnalyticsExportQuery, success: { status: 200, description: "text/csv attachment" }, errors: [400, 401, 403],
  },
  {
    method: "post", path: "/prospects/{id}/merge", id: "mergeProspects", summary: "Hide a duplicate behind this prospect (non-destructive, reversible, audited; no chains)", tag: "Prospecting", permission: "prospects:manage",
    pathParams: ["id"], body: C.MergeProspectRequest, success: { status: 201, schema: C.ProspectMergeDto, description: "Merge" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/prospects/{id}/merges", id: "listProspectMerges", summary: "Merges where this prospect is the survivor or the hidden duplicate (history included)", tag: "Prospecting", permission: "prospects:read",
    pathParams: ["id"], success: { status: 200, schema: C.ProspectMergeListDto, description: "Merges" }, errors: [400, 401, 403, 404],
  },
  {
    method: "post", path: "/prospects/{id}/merges/{mergeId}/revert", id: "revertProspectMerge", summary: "Undo a merge; the duplicate reappears unchanged", tag: "Prospecting", permission: "prospects:manage",
    pathParams: ["id", "mergeId"], success: { status: 200, schema: C.ProspectMergeDto, description: "Reverted merge" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/prospects/export", id: "exportProspects", summary: "CSV of prospects (optional status/country filters; formula-safe, capped; audited)", tag: "Prospecting", permission: "prospects:read",
    query: C.ProspectExportQuery, success: { status: 200, description: "text/csv attachment" }, errors: [400, 401, 403],
  },
  {
    method: "post", path: "/ai/analyze", id: "aiAnalyze", summary: "Run a capability through the AI gateway: budget check, PII minimisation, evidence-only prompt, schema and groundedness validation, usage ledger. 503 without a configured provider", tag: "AI", permission: "ai:use",
    body: C.AiAnalyzeRequest, success: { status: 201, schema: C.AiRunDto, description: "Recorded run (status ok or needs_review)" }, errors: [400, 401, 403, 409, 429, 503],
  },
  {
    method: "get", path: "/ai/runs", id: "listAiRuns", summary: "AI runs of the organization (keyset by id); filter by needsReview", tag: "AI", permission: "ai:use",
    query: C.AiRunListQuery, success: { status: 200, schema: C.AiRunPageDto, description: "Page" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/ai/usage", id: "getAiUsage", summary: "Current UTC month spend against the tenant budget", tag: "AI", permission: "ai:use",
    success: { status: 200, schema: C.AiUsageDto, description: "Usage" }, errors: [401, 403],
  },
  {
    method: "put", path: "/ai/budget", id: "setAiBudget", summary: "Set the monthly AI budget (micro-units). Without a budget AI is blocked for the tenant", tag: "AI", permission: "ai:manage",
    body: C.SetAiBudgetRequest, success: { status: 200, schema: C.AiUsageDto, description: "Usage with the new limit" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/ai/usage-summary", id: "getAiUsageSummary", summary: "Current month: MCP tool calls (by tool, user, day) against the internal limit, and API AI spend against the budget. The Claude Pro plan percentage is not visible to the SaaS", tag: "AI", permission: "ai:use",
    success: { status: 200, schema: C.AiUsageSummaryDto, description: "Summary" }, errors: [401, 403],
  },
  {
    method: "put", path: "/ai/mcp-limit", id: "setMcpLimit", summary: "Set the monthly internal limit of MCP tool calls (0 = no limit)", tag: "AI", permission: "ai:manage",
    body: C.SetMcpLimitRequest, success: { status: 200, schema: C.AiUsageSummaryDto, description: "Summary with the new limit" }, errors: [400, 401, 403],
  },
  {
    method: "post", path: "/ai/mcp-usage", id: "reportMcpUsage", summary: "Used by the MCP server to record one tool call (metadata only; organization and user come from the token)", tag: "AI", permission: "ai:use",
    body: C.ReportMcpUsageRequest, success: { status: 204, description: "Recorded" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/prospects/cohorts", id: "listProspectCohorts", summary: "Monthly prospect cohorts: discovered, active, converted, rejected, no reply, expired, and the monthly lead quota used", tag: "Prospects", permission: "prospects:read",
    success: { status: 200, schema: C.CohortListDto, description: "Cohorts" }, errors: [401, 403],
  },
  {
    method: "get", path: "/prospects/lead-quota", id: "getLeadQuota", summary: "Monthly lead quota of the organization", tag: "Prospects", permission: "prospects:read",
    success: { status: 200, schema: C.LeadQuotaDto, description: "Quota" }, errors: [401, 403],
  },
  {
    method: "put", path: "/prospects/lead-quota", id: "setLeadQuota", summary: "Set the monthly lead quota", tag: "Prospects", permission: "organization:update",
    body: C.SetLeadQuotaRequest, success: { status: 200, schema: C.LeadQuotaDto, description: "Quota" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/notifications/email-destinations", id: "getNotificationEmailDestinations", summary: "Where to send notifications by e-mail (up to 5 addresses) and the enabled event types", tag: "Notifications", permission: "organization:update",
    success: { status: 200, schema: C.NotificationEmailDestinationsDto, description: "Destinations" }, errors: [401, 403],
  },
  {
    method: "put", path: "/notifications/email-destinations", id: "replaceNotificationEmailDestinations", summary: "Replace the e-mail destinations (max 5) and optionally the enabled event types", tag: "Notifications", permission: "organization:update",
    body: C.UpdateNotificationEmailDestinationsRequest, success: { status: 200, schema: C.NotificationEmailDestinationsDto, description: "Destinations" }, errors: [400, 401, 403],
  },
  {
    method: "post", path: "/notifications/email-destinations/{id}/test", id: "testNotificationEmailDestination", summary: "Queue a test e-mail to one destination (sent by the worker, never in the request)", tag: "Notifications", permission: "organization:update",
    pathParams: ["id"], success: { status: 202, schema: C.NotificationEmailTestQueuedDto, description: "Queued" }, errors: [401, 403, 404],
  },
  {
    method: "get", path: "/platform-admin/organizations", id: "platformAdminListOrganizations", summary: "Platform administrator only, read-only and audited: organizations with counts", tag: "Platform admin",
    query: C.PlatformAdminPageQuery, success: { status: 200, schema: z.object({ total: z.number(), limit: z.number(), offset: z.number(), items: z.array(C.PlatformAdminOrganizationDto) }), description: "Page" }, errors: [401, 403],
  },
  {
    method: "get", path: "/platform-admin/organizations/{id}/{resource}", id: "platformAdminListResource", summary: "Platform administrator only, read-only and audited: users, prospects, leads, opportunities, quotes or campaigns of one organization", tag: "Platform admin",
    pathParams: ["id", "resource"], query: C.PlatformAdminPageQuery, success: { status: 200, schema: z.object({ total: z.number(), limit: z.number(), offset: z.number(), items: z.array(z.record(z.string(), z.unknown())) }), description: "Page" }, errors: [400, 401, 403, 404],
  },
  {
    method: "post", path: "/prospects/{id}/contacts", id: "addContact", summary: "Add an email (default) or WhatsApp (E.164) contact to a prospect; a contact has one channel (source required; no consent is implied)", tag: "Campaigns", permission: "prospects:manage",
    pathParams: ["id"], body: C.AddContactRequest, success: { status: 201, schema: C.ContactDto, description: "Created" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/prospects/{id}/contacts", id: "listContacts", summary: "Contacts of a prospect with their current consent", tag: "Campaigns", permission: "campaigns:read",
    pathParams: ["id"], success: { status: 200, schema: C.ContactListDto, description: "Contacts" }, errors: [400, 401, 403, 404],
  },
  {
    method: "post", path: "/contacts/{id}/consent", id: "recordConsent", summary: "Record a granted/withdrawn consent with its evidence (append-only ledger)", tag: "Campaigns", permission: "prospects:manage",
    pathParams: ["id"], body: C.RecordConsentRequest, success: { status: 201, schema: C.ContactDto, description: "Recorded" }, errors: [400, 401, 403, 404],
  },
  {
    method: "post", path: "/campaigns", id: "createCampaign", summary: "Create a draft campaign (one email; the body must contain {{unsubscribe_url}})", tag: "Campaigns", permission: "campaigns:manage",
    body: C.CreateCampaignRequest, success: { status: 201, schema: C.CampaignDto, description: "Created" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/campaigns", id: "listCampaigns", summary: "Campaigns (keyset by id)", tag: "Campaigns", permission: "campaigns:read",
    query: C.CampaignListQuery, success: { status: 200, schema: C.CampaignPageDto, description: "Page" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/campaigns/{id}", id: "getCampaign", summary: "One campaign with attempt counts", tag: "Campaigns", permission: "campaigns:read",
    pathParams: ["id"], success: { status: 200, schema: C.CampaignDto, description: "Campaign" }, errors: [400, 401, 403, 404],
  },
  {
    method: "patch", path: "/campaigns/{id}", id: "updateCampaign", summary: "Edit a DRAFT campaign", tag: "Campaigns", permission: "campaigns:manage",
    pathParams: ["id"], body: C.UpdateCampaignRequest, success: { status: 200, schema: C.CampaignDto, description: "Updated" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/campaigns/{id}/approve", id: "approveCampaign", summary: "Approve a draft (org_admin, sales_manager); approver and time are stamped by the database", tag: "Campaigns", permission: "campaigns:approve",
    pathParams: ["id"], success: { status: 200, schema: C.CampaignDto, description: "Approved" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/campaigns/{id}/preview", id: "previewAudience", summary: "Who would be reached and why the rest is excluded (consent, opt-out, suppression, frequency)", tag: "Campaigns", permission: "campaigns:read",
    pathParams: ["id"], success: { status: 200, schema: C.AudiencePreviewDto, description: "Preview" }, errors: [400, 401, 403, 404],
  },
  {
    method: "post", path: "/campaigns/{id}/launch", id: "launchCampaign", summary: "Start an APPROVED campaign: queue one attempt per eligible contact (idempotent)", tag: "Campaigns", permission: "campaigns:manage",
    pathParams: ["id"], success: { status: 200, schema: C.CampaignDto, description: "Running" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/campaigns/{id}/dispatch", id: "dispatchCampaign", summary: "Process queued attempts through the configured email adapter, re-checking consent and suppression for EACH one. 503 without an adapter", tag: "Campaigns", permission: "campaigns:manage",
    pathParams: ["id"], body: C.DispatchRequest, success: { status: 200, schema: C.DispatchResultDto, description: "Result" }, errors: [400, 401, 403, 404, 409, 503],
  },
  {
    method: "post", path: "/campaigns/{id}/pause", id: "pauseCampaign", summary: "Pause a running campaign", tag: "Campaigns", permission: "campaigns:manage",
    pathParams: ["id"], success: { status: 200, schema: C.CampaignDto, description: "Paused" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/campaigns/{id}/resume", id: "resumeCampaign", summary: "Resume a paused campaign", tag: "Campaigns", permission: "campaigns:manage",
    pathParams: ["id"], success: { status: 200, schema: C.CampaignDto, description: "Running" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/campaigns/{id}/cancel", id: "cancelCampaign", summary: "Cancel a campaign and its queued attempts", tag: "Campaigns", permission: "campaigns:manage",
    pathParams: ["id"], success: { status: 200, schema: C.CampaignDto, description: "Cancelled" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/campaigns/{id}/attempts", id: "listAttempts", summary: "Send attempts of a campaign with their outcome (keyset by id)", tag: "Campaigns", permission: "campaigns:read",
    pathParams: ["id"], query: C.AttemptListQuery, success: { status: 200, schema: C.AttemptPageDto, description: "Page" }, errors: [400, 401, 403, 404],
  },
  {
    method: "post", path: "/public/unsubscribe", id: "unsubscribe", summary: "Self-service unsubscribe from a signed link in a message; identical answer for every valid-looking request", tag: "Campaigns", public: true,
    body: C.UnsubscribeRequest, success: { status: 204, description: "Unsubscribed (or already)" }, errors: [400, 429],
  },
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
  {
    method: "post", path: "/auth/change-password", id: "changePassword", summary: "Change the caller's password (verifies the current one, throttled) and revoke every other session in all organizations", tag: "Auth",
    body: C.ChangePasswordRequest, success: { status: 200, schema: C.ChangedPasswordDto, description: "Password changed" }, errors: [400, 401, 403, 429],
  },
  {
    method: "get", path: "/auth/sessions", id: "listMySessions", summary: "Active sessions of the caller in the current organization (current one flagged)", tag: "Auth",
    success: { status: 200, schema: C.SessionInfoListDto, description: "Sessions" }, errors: [401],
  },
  {
    method: "delete", path: "/auth/sessions/{id}", id: "revokeMySession", summary: "Revoke another of the caller's own sessions in the current organization", tag: "Auth",
    pathParams: ["id"], success: { status: 204, description: "Revoked" }, errors: [400, 401, 404, 409],
  },
  {
    method: "get", path: "/me/organizations", id: "listMyOrganizations", summary: "Organizations where the caller has an active membership (for the switcher); the current one is flagged", tag: "Auth",
    success: { status: 200, schema: C.MyOrganizationsDto, description: "Organizations" }, errors: [401],
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
    method: "get", path: "/organization/profile", id: "getProfile", summary: "Company profile (all fields null until the tenant fills them)", tag: "Organization", permission: "organization:read",
    success: { status: 200, schema: C.ProfileDto, description: "Profile" }, errors: [401, 403],
  },
  {
    method: "put", path: "/organization/profile", id: "replaceProfile", summary: "Replace the company profile (omitted fields are cleared)", tag: "Organization", permission: "organization:update",
    body: C.UpdateProfileRequest, success: { status: 200, schema: C.ProfileDto, description: "Profile" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/organization/email-settings", id: "getEmailSettings", summary: "The organization's own SMTP account (the password is never returned)", tag: "Organization", permission: "organization:update",
    query: C.EmailSettingsPurposeQuery,
    success: { status: 200, schema: C.EmailSettingsDto, description: "Settings" }, errors: [401, 403],
  },
  {
    method: "put", path: "/organization/email-settings", id: "replaceEmailSettings", summary: "Save the organization's SMTP account (password stored encrypted; resets verification)", tag: "Organization", permission: "organization:update",
    query: C.EmailSettingsPurposeQuery,
    body: C.UpdateEmailSettingsRequest, success: { status: 200, schema: C.EmailSettingsDto, description: "Settings" }, errors: [400, 401, 403],
  },
  {
    method: "delete", path: "/organization/email-settings", id: "deleteEmailSettings", summary: "Remove the organization's SMTP account", tag: "Organization", permission: "organization:update",
    query: C.EmailSettingsPurposeQuery,
    success: { status: 200, schema: C.EmailSettingsDto, description: "Empty settings" }, errors: [401, 403],
  },
  {
    method: "post", path: "/organization/email-settings/test", id: "testEmailSettings", summary: "Check the SMTP connection and login; optionally send one test message", tag: "Organization", permission: "organization:update",
    query: C.EmailSettingsPurposeQuery,
    body: C.TestEmailSettingsRequest, success: { status: 200, schema: C.EmailSettingsTestDto, description: "Result" }, errors: [400, 401, 403, 409],
  },
  {
    method: "get", path: "/branches", id: "listBranches", summary: "Branches of the caller's organization (active and disabled)", tag: "Branches", permission: "organization:read",
    success: { status: 200, schema: z.array(C.BranchDto), description: "Branches" }, errors: [401, 403],
  },
  {
    method: "post", path: "/branches", id: "createBranch", summary: "Create a branch (name unique per organization, case-insensitive)", tag: "Branches", permission: "organization:update",
    body: C.CreateBranchRequest, success: { status: 201, schema: C.BranchDto, description: "Created" }, errors: [400, 401, 403, 409],
  },
  {
    method: "patch", path: "/branches/{id}", id: "updateBranch", summary: "Edit or disable a branch (branches are never deleted)", tag: "Branches", permission: "organization:update",
    pathParams: ["id"], body: C.UpdateBranchRequest, success: { status: 200, schema: C.BranchDto, description: "Updated" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/catalog/categories", id: "listCategories", summary: "Catalog categories", tag: "Catalog", permission: "catalog:read",
    success: { status: 200, schema: z.array(C.CategoryDto), description: "Categories" }, errors: [401, 403],
  },
  {
    method: "post", path: "/catalog/categories", id: "createCategory", summary: "Create a category (name unique per organization, case-insensitive)", tag: "Catalog", permission: "catalog:manage",
    body: C.CreateCategoryRequest, success: { status: 201, schema: C.CategoryDto, description: "Created" }, errors: [400, 401, 403, 409],
  },
  {
    method: "patch", path: "/catalog/categories/{id}", id: "updateCategory", summary: "Rename or disable a category", tag: "Catalog", permission: "catalog:manage",
    pathParams: ["id"], body: C.UpdateCategoryRequest, success: { status: 200, schema: C.CategoryDto, description: "Updated" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/catalog/items", id: "listItems", summary: "Items with their approved and draft content (keyset pagination)", tag: "Catalog", permission: "catalog:read",
    query: C.ItemListQuery, success: { status: 200, schema: C.ItemPageDto, description: "Page of items" }, errors: [400, 401, 403],
  },
  {
    method: "post", path: "/catalog/items", id: "createItem", summary: "Create an item with version 1 as a draft (SKU unique per organization)", tag: "Catalog", permission: "catalog:manage",
    body: C.CreateItemRequest, success: { status: 201, schema: C.ItemDto, description: "Created" }, errors: [400, 401, 403, 409],
  },
  {
    method: "get", path: "/catalog/items/{id}", id: "getItem", summary: "One item", tag: "Catalog", permission: "catalog:read",
    pathParams: ["id"], success: { status: 200, schema: C.ItemDto, description: "Item" }, errors: [400, 401, 403, 404],
  },
  {
    method: "patch", path: "/catalog/items/{id}", id: "updateItemDraft", summary: "Edit the open draft (409 if there is none)", tag: "Catalog", permission: "catalog:manage",
    pathParams: ["id"], body: C.UpdateItemDraftRequest, success: { status: 200, schema: C.ItemDto, description: "Updated" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/catalog/items/{id}/versions", id: "listItemVersions", summary: "Version history (immutable once approved)", tag: "Catalog", permission: "catalog:read",
    pathParams: ["id"], success: { status: 200, schema: z.array(C.ItemVersionDto), description: "Versions, newest first" }, errors: [400, 401, 403, 404],
  },
  {
    method: "post", path: "/catalog/items/{id}/versions", id: "createItemDraft", summary: "Start a new draft copied from the latest version (409 if a draft is open)", tag: "Catalog", permission: "catalog:manage",
    pathParams: ["id"], success: { status: 201, schema: C.ItemDto, description: "Draft created" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/catalog/items/{id}/approve", id: "approveItem", summary: "Approve the open draft; the previous approved version is superseded", tag: "Catalog", permission: "catalog:approve",
    pathParams: ["id"], success: { status: 200, schema: C.ItemDto, description: "Approved" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/catalog/items/{id}/archive", id: "archiveItem", summary: "Archive an item (its approved content stops being consumable)", tag: "Catalog", permission: "catalog:approve",
    pathParams: ["id"], success: { status: 200, schema: C.ItemDto, description: "Archived" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/catalog/items/{id}/restore", id: "restoreItem", summary: "Restore an archived item", tag: "Catalog", permission: "catalog:approve",
    pathParams: ["id"], success: { status: 200, schema: C.ItemDto, description: "Restored" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/catalog/price-lists", id: "listPriceLists", summary: "Price lists (keyset by id)", tag: "Pricing", permission: "catalog:read",
    query: C.PriceListQuery, success: { status: 200, schema: C.PriceListPageDto, description: "Page" }, errors: [400, 401, 403],
  },
  {
    method: "post", path: "/catalog/price-lists", id: "createPriceList", summary: "Create a draft price list (name unique, currency fixed)", tag: "Pricing", permission: "catalog:manage",
    body: C.CreatePriceListRequest, success: { status: 201, schema: C.PriceListDto, description: "Created" }, errors: [400, 401, 403, 409],
  },
  {
    method: "get", path: "/catalog/price-lists/{id}", id: "getPriceList", summary: "One price list", tag: "Pricing", permission: "catalog:read",
    pathParams: ["id"], success: { status: 200, schema: C.PriceListDto, description: "Price list" }, errors: [400, 401, 403, 404],
  },
  {
    method: "patch", path: "/catalog/price-lists/{id}", id: "updatePriceList", summary: "Edit name/validity of a draft list", tag: "Pricing", permission: "catalog:manage",
    pathParams: ["id"], body: C.UpdatePriceListRequest, success: { status: 200, schema: C.PriceListDto, description: "Updated" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/catalog/price-lists/{id}/clone", id: "clonePriceList", summary: "Copy a list (any status) into a new draft with all its entries", tag: "Pricing", permission: "catalog:manage",
    pathParams: ["id"], body: C.ClonePriceListRequest, success: { status: 201, schema: C.PriceListDto, description: "Cloned" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/catalog/price-lists/{id}/approve", id: "approvePriceList", summary: "Approve a draft: needs entries and every priced item approved", tag: "Pricing", permission: "catalog:approve",
    pathParams: ["id"], success: { status: 200, schema: C.PriceListDto, description: "Approved" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/catalog/price-lists/{id}/archive", id: "archivePriceList", summary: "Archive a list (not consumable, immutable)", tag: "Pricing", permission: "catalog:approve",
    pathParams: ["id"], success: { status: 200, schema: C.PriceListDto, description: "Archived" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/catalog/price-lists/{id}/entries", id: "listPriceEntries", summary: "Entries of a list (keyset by id)", tag: "Pricing", permission: "catalog:read",
    pathParams: ["id"], query: C.PageQuery, success: { status: 200, schema: C.PriceEntryPageDto, description: "Page" }, errors: [400, 401, 403, 404],
  },
  {
    method: "put", path: "/catalog/price-lists/{id}/entries/{itemId}", id: "setPrice", summary: "Set the price of an item in a draft list (idempotent)", tag: "Pricing", permission: "catalog:manage",
    pathParams: ["id", "itemId"], body: C.SetPriceRequest, success: { status: 200, schema: C.PriceEntryDto, description: "Entry" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "delete", path: "/catalog/price-lists/{id}/entries/{itemId}", id: "removePrice", summary: "Remove an item's price from a draft list", tag: "Pricing", permission: "catalog:manage",
    pathParams: ["id", "itemId"], success: { status: 204, description: "Removed" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/catalog/price-lists/{id}/approved-prices", id: "listApprovedPrices", summary: "CONSUMPTION VIEW: prices of an approved list whose items are currently approved", tag: "Pricing", permission: "catalog:read",
    pathParams: ["id"], query: C.PageQuery, success: { status: 200, schema: C.ApprovedPricePageDto, description: "Page" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/catalog/imports", id: "importCatalogCsv", summary: "Validate (dry_run) or apply a CSV of items. All-or-nothing: any row error rejects the whole apply. Creates/updates DRAFTS only", tag: "Catalog", permission: "catalog:manage",
    body: C.ImportRequest, idempotent: true, success: { status: 200, schema: C.ImportResultDto, description: "Outcome with per-row actions and errors" }, errors: [400, 401, 403, 409, 413, 422],
  },
  {
    method: "get", path: "/catalog/imports", id: "listImportJobs", summary: "Import history (keyset by id)", tag: "Catalog", permission: "catalog:manage",
    query: C.PageQuery, success: { status: 200, schema: C.ImportJobPageDto, description: "Page" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/catalog/imports/{id}", id: "getImportJob", summary: "One import job", tag: "Catalog", permission: "catalog:manage",
    pathParams: ["id"], success: { status: 200, schema: C.ImportJobDto, description: "Job" }, errors: [400, 401, 403, 404],
  },
  {
    method: "get", path: "/catalog/evidence", id: "getEvidence", summary: "Approved facts for one SKU (and optionally its price in an approved list), each with a citable ref, or explicit no_evidence + reason", tag: "Evidence", permission: "catalog:read",
    query: C.EvidenceQuery, success: { status: 200, schema: C.EvidenceDto, description: "Evidence or no_evidence" }, errors: [400, 401, 403],
  },
  {
    method: "post", path: "/catalog/evidence/resolve", id: "resolveEvidenceRefs", summary: "Check citations: current, superseded, archived or no_evidence (malformed or unknown refs are answers, not errors)", tag: "Evidence", permission: "catalog:read",
    body: C.ResolveRefsRequest, success: { status: 200, schema: C.ResolveRefsDto, description: "One result per ref, in order" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/prospects", id: "listProspects", summary: "Prospects (keyset by id; filters; suppressed flag computed)", tag: "Prospecting", permission: "prospects:read",
    query: C.ProspectListQuery, success: { status: 200, schema: C.ProspectPageDto, description: "Page" }, errors: [400, 401, 403],
  },
  {
    method: "post", path: "/prospects", id: "createProspect", summary: "Create a candidate (manual provenance recorded). Duplicate domain or name|country -> 409 with details.existingId", tag: "Prospecting", permission: "prospects:manage",
    body: C.CreateProspectRequest, success: { status: 201, schema: C.ProspectDto, description: "Created" }, errors: [400, 401, 403, 409],
  },
  {
    method: "get", path: "/prospects/{id}", id: "getProspect", summary: "One prospect with its provenance", tag: "Prospecting", permission: "prospects:read",
    pathParams: ["id"], success: { status: 200, schema: C.ProspectDetailDto, description: "Prospect" }, errors: [400, 401, 403, 404],
  },
  {
    method: "patch", path: "/prospects/{id}", id: "updateProspect", summary: "Edit a prospect", tag: "Prospecting", permission: "prospects:manage",
    pathParams: ["id"], body: C.UpdateProspectRequest, success: { status: 200, schema: C.ProspectDto, description: "Updated" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/prospects/{id}/status", id: "setProspectStatus", summary: "Qualify/disqualify. Suppressed prospects cannot be qualified", tag: "Prospecting", permission: "prospects:manage",
    pathParams: ["id"], body: C.SetProspectStatusRequest, success: { status: 200, schema: C.ProspectDto, description: "Updated" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/prospects/connectors", id: "listConnectors", summary: "Prospecting connectors available to this deployment (none until a provider is approved)", tag: "Prospecting", permission: "prospects:read",
    success: { status: 200, schema: C.ConnectorsDto, description: "Connectors" }, errors: [401, 403],
  },
  {
    method: "post", path: "/prospects/imports", id: "importProspectsCsv", summary: "Validate (dry_run) or apply a CSV of prospects. All-or-nothing; never changes status; records csv_import provenance", tag: "Prospecting", permission: "prospects:manage",
    body: C.ImportRequest, idempotent: true, success: { status: 200, schema: C.ProspectImportResultDto, description: "Outcome" }, errors: [400, 401, 403, 409, 413, 422],
  },
  {
    method: "post", path: "/prospects/discovery/search", id: "searchProspectDiscovery", summary: "Preview businesses near a place from OpenStreetMap (nothing is stored)", tag: "Prospecting", permission: "prospects:manage",
    body: C.DiscoverySearchRequest, success: { status: 200, schema: C.DiscoverySearchDto, description: "Candidates" }, errors: [400, 401, 403, 503],
  },
  {
    method: "post", path: "/prospects/discovery/import", id: "importProspectDiscovery", summary: "Store selected OpenStreetMap candidates as prospects (dedupe and suppression respected; openstreetmap provenance)", tag: "Prospecting", permission: "prospects:manage",
    body: C.DiscoveryImportRequest, success: { status: 200, schema: C.DiscoveryImportDto, description: "Outcome" }, errors: [400, 401, 403, 503],
  },
  {
    method: "get", path: "/prospects/imports", id: "listProspectImports", summary: "Prospect import history (keyset by id)", tag: "Prospecting", permission: "prospects:manage",
    query: C.PageQuery, success: { status: 200, schema: C.ProspectImportJobPageDto, description: "Page" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/prospects/imports/{id}", id: "getProspectImport", summary: "One prospect import job", tag: "Prospecting", permission: "prospects:manage",
    pathParams: ["id"], success: { status: 200, schema: C.ProspectImportJobDto, description: "Job" }, errors: [400, 401, 403, 404],
  },
  {
    method: "get", path: "/suppressions", id: "listSuppressions", summary: "Do-not-contact list", tag: "Prospecting", permission: "prospects:read",
    success: { status: 200, schema: C.SuppressionListDto, description: "Entries" }, errors: [401, 403],
  },
  {
    method: "post", path: "/suppressions", id: "createSuppression", summary: "Add a domain or name; matching qualified prospects are disqualified immediately", tag: "Prospecting", permission: "suppressions:manage",
    body: C.CreateSuppressionRequest, success: { status: 201, schema: C.SuppressionDto, description: "Created" }, errors: [400, 401, 403, 409],
  },
  {
    method: "delete", path: "/suppressions/{id}", id: "removeSuppression", summary: "Remove an entry (org_admin only, audited)", tag: "Prospecting", permission: "suppressions:remove",
    pathParams: ["id"], success: { status: 204, description: "Removed" }, errors: [400, 401, 403, 404],
  },
  {
    method: "get", path: "/prospects/{id}/attributes", id: "listAttributes", summary: "Enrichment values with provenance; conflicting values are flagged", tag: "Scoring", permission: "prospects:read",
    pathParams: ["id"], success: { status: 200, schema: C.AttributeListDto, description: "Attributes" }, errors: [400, 401, 403, 404],
  },
  {
    method: "post", path: "/prospects/{id}/attributes", id: "addAttribute", summary: "Add an unverified value (never overwrites an existing one)", tag: "Scoring", permission: "prospects:manage",
    pathParams: ["id"], body: C.CreateAttributeRequest, success: { status: 201, schema: C.AttributeDto, description: "Created" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/prospects/{id}/attributes/{attributeId}/decision", id: "decideAttribute", summary: "Verify (rejects the other values of that key) or reject a value", tag: "Scoring", permission: "prospects:manage",
    pathParams: ["id", "attributeId"], body: C.AttributeDecisionRequest, success: { status: 200, schema: C.AttributeDto, description: "Decided" }, errors: [400, 401, 403, 404],
  },
  {
    method: "get", path: "/scoring/model", id: "getScoringModel", summary: "Approved and draft scoring model versions", tag: "Scoring", permission: "prospects:read",
    success: { status: 200, schema: C.ScoringModelDto, description: "Model" }, errors: [401, 403],
  },
  {
    method: "put", path: "/scoring/model/draft", id: "saveScoringDraft", summary: "Create or replace the open draft (rules are transparent and validated)", tag: "Scoring", permission: "scoring:manage",
    body: C.SaveScoringDraftRequest, success: { status: 200, schema: C.ScoringModelDto, description: "Model" }, errors: [400, 401, 403],
  },
  {
    method: "post", path: "/scoring/model/approve", id: "approveScoringModel", summary: "Approve the draft; the previous version is superseded", tag: "Scoring", permission: "scoring:approve",
    success: { status: 200, schema: C.ScoringModelDto, description: "Model" }, errors: [401, 403, 409],
  },
  {
    method: "post", path: "/scoring/recompute", id: "recomputeScores", summary: "Score every non-suppressed prospect with the approved model", tag: "Scoring", permission: "prospects:manage",
    success: { status: 200, schema: C.RecomputeDto, description: "Counts" }, errors: [401, 403, 409],
  },
  {
    method: "get", path: "/prospects/{id}/score", id: "getProspectScore", summary: "Latest explainable score", tag: "Scoring", permission: "prospects:read",
    pathParams: ["id"], success: { status: 200, schema: C.ProspectScoreDto, description: "Score" }, errors: [400, 401, 403, 404],
  },
  {
    method: "post", path: "/prospects/{id}/score", id: "scoreProspect", summary: "Compute and store a score with the approved model", tag: "Scoring", permission: "prospects:manage",
    pathParams: ["id"], success: { status: 201, schema: C.ScoreResultDto, description: "Score" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/prospects/{id}/replies", id: "assessReply", summary: "Classify a pasted reply by explicit rules; unsubscribe suppresses, positive intent opens a lead for review", tag: "Leads", permission: "prospects:manage",
    pathParams: ["id"], body: C.AssessReplyRequest, success: { status: 201, schema: C.IntentAssessmentDto, description: "Assessment" }, errors: [400, 401, 403, 404],
  },
  {
    method: "get", path: "/prospects/{id}/replies", id: "listReplyAssessments", summary: "Classification history of a prospect", tag: "Leads", permission: "prospects:read",
    pathParams: ["id"], success: { status: 200, schema: C.IntentAssessmentListDto, description: "Assessments" }, errors: [400, 401, 403, 404],
  },
  {
    method: "get", path: "/leads/settings", id: "getLeadSettings", summary: "Minimum score for rule-created leads (null until configured)", tag: "Leads", permission: "leads:read",
    success: { status: 200, schema: C.LeadSettingsDto, description: "Settings" }, errors: [401, 403],
  },
  {
    method: "put", path: "/leads/settings", id: "setLeadSettings", summary: "Set the minimum score (org_admin)", tag: "Leads", permission: "scoring:approve",
    body: C.SetLeadSettingsRequest, success: { status: 200, schema: C.LeadSettingsDto, description: "Settings" }, errors: [400, 401, 403],
  },
  {
    method: "post", path: "/leads/evaluate", id: "evaluateLeads", summary: "Create pending leads for qualified, non-suppressed prospects scoring at or above the threshold (idempotent)", tag: "Leads", permission: "leads:review",
    success: { status: 200, schema: C.EvaluateLeadsDto, description: "Counts" }, errors: [401, 403, 409],
  },
  {
    method: "get", path: "/leads", id: "listLeads", summary: "Leads (keyset by id)", tag: "Leads", permission: "leads:read",
    query: C.LeadListQuery, success: { status: 200, schema: C.LeadPageDto, description: "Page" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/leads/{id}", id: "getLead", summary: "One lead with its evidence", tag: "Leads", permission: "leads:read",
    pathParams: ["id"], success: { status: 200, schema: C.LeadDto, description: "Lead" }, errors: [400, 401, 403, 404],
  },
  {
    method: "post", path: "/leads/{id}/decision", id: "decideLead", summary: "Accept or reject a pending lead (human review)", tag: "Leads", permission: "leads:review",
    pathParams: ["id"], body: C.LeadDecisionRequest, success: { status: 200, schema: C.LeadDto, description: "Lead" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/opportunities/{id}/tasks", id: "createTask", summary: "Create a follow-up task (assignee defaults to the opportunity owner; sellers can only assign themselves)", tag: "CRM", permission: "crm:work",
    pathParams: ["id"], body: C.CreateTaskRequest, success: { status: 201, schema: C.TaskDto, description: "Created" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/opportunities/{id}/tasks", id: "listOpportunityTasks", summary: "Tasks of one opportunity (due date order, keyset by id)", tag: "CRM", permission: "crm:read",
    pathParams: ["id"], query: C.TaskListQuery, success: { status: 200, schema: C.TaskPageDto, description: "Tasks" }, errors: [400, 401, 403, 404],
  },
  {
    method: "get", path: "/tasks", id: "listTasks", summary: "Tasks visible to the caller (sellers: only those of their opportunities); filter by state, assignee, overdue", tag: "CRM", permission: "crm:read",
    query: C.TaskListQuery, success: { status: 200, schema: C.TaskPageDto, description: "Tasks" }, errors: [400, 401, 403, 404],
  },
  {
    method: "post", path: "/tasks/{id}/complete", id: "completeTask", summary: "Complete an open task (completion time and user are stamped by the database)", tag: "CRM", permission: "crm:work",
    pathParams: ["id"], success: { status: 200, schema: C.TaskDto, description: "Completed" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/tasks/{id}/cancel", id: "cancelTask", summary: "Cancel an open task", tag: "CRM", permission: "crm:work",
    pathParams: ["id"], success: { status: 200, schema: C.TaskDto, description: "Cancelled" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/notifications", id: "listNotifications", summary: "The caller's own in-app notifications (newest first, keyset by id; unread filter)", tag: "Notifications", permission: "organization:read",
    query: C.NotificationListQuery, success: { status: 200, schema: C.NotificationPageDto, description: "Notifications" }, errors: [400, 401, 403, 404],
  },
  {
    method: "get", path: "/notifications/unread-count", id: "countUnreadNotifications", summary: "Number of unread notifications of the caller", tag: "Notifications", permission: "organization:read",
    success: { status: 200, schema: C.NotificationCountDto, description: "Unread count" }, errors: [401, 403],
  },
  {
    method: "post", path: "/notifications/read-all", id: "readAllNotifications", summary: "Mark all of the caller's notifications as read", tag: "Notifications", permission: "organization:read",
    success: { status: 200, schema: C.NotificationReadAllDto, description: "Updated" }, errors: [401, 403],
  },
  {
    method: "post", path: "/notifications/{id}/read", id: "readNotification", summary: "Mark one of the caller's notifications as read (idempotent)", tag: "Notifications", permission: "organization:read",
    pathParams: ["id"], success: { status: 200, schema: C.NotificationDto, description: "Notification" }, errors: [400, 401, 403, 404],
  },
  {
    method: "get", path: "/notifications/preferences", id: "getNotificationPreferences", summary: "Per-event-type preferences of the caller (all enabled by default)", tag: "Notifications", permission: "organization:read",
    success: { status: 200, schema: C.NotificationPreferencesDto, description: "Preferences" }, errors: [401, 403],
  },
  {
    method: "put", path: "/notifications/preferences", id: "setNotificationPreferences", summary: "Enable or disable event types for the caller (audited)", tag: "Notifications", permission: "organization:read",
    body: C.UpdateNotificationPreferencesRequest, success: { status: 200, schema: C.NotificationPreferencesDto, description: "Preferences" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/opportunities", id: "listOpportunities", summary: "Opportunities (sellers see only those assigned to them; keyset by id)", tag: "CRM", permission: "crm:read",
    query: C.OpportunityListQuery, success: { status: 200, schema: C.OpportunityPageDto, description: "Page" }, errors: [400, 401, 403],
  },
  {
    method: "post", path: "/opportunities", id: "createOpportunity", summary: "Create from one ACCEPTED lead (auto-assigned when the strategy is round_robin)", tag: "CRM", permission: "crm:manage",
    body: C.CreateOpportunityRequest, success: { status: 201, schema: C.OpportunityDto, description: "Created" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/opportunities/summary", id: "getPipelineSummary", summary: "Count per stage (kanban)", tag: "CRM", permission: "crm:read",
    success: { status: 200, schema: C.PipelineSummaryDto, description: "Counts" }, errors: [401, 403],
  },
  {
    method: "get", path: "/opportunities/{id}", id: "getOpportunity", summary: "Opportunity with its immutable timeline", tag: "CRM", permission: "crm:read",
    pathParams: ["id"], success: { status: 200, schema: C.OpportunityDetailDto, description: "Opportunity" }, errors: [400, 401, 403, 404],
  },
  {
    method: "post", path: "/opportunities/{id}/stage", id: "changeStage", summary: "Move through the valid stage machine (history is written by the database)", tag: "CRM", permission: "crm:work",
    pathParams: ["id"], body: C.ChangeStageRequest, success: { status: 200, schema: C.OpportunityDto, description: "Updated" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/opportunities/{id}/notes", id: "addOpportunityNote", summary: "Log a note, call, email or meeting", tag: "CRM", permission: "crm:work",
    pathParams: ["id"], body: C.AddNoteRequest, success: { status: 201, schema: C.OpportunityDetailDto, description: "Opportunity" }, errors: [400, 401, 403, 404],
  },
  {
    method: "post", path: "/opportunities/{id}/assign", id: "assignOpportunity", summary: "Assign manually (or null to return to the queue); reassignment keeps the history", tag: "CRM", permission: "crm:manage",
    pathParams: ["id"], body: C.AssignRequest, success: { status: 200, schema: C.OpportunityDto, description: "Updated" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/opportunities/{id}/auto-assign", id: "autoAssignOpportunity", summary: "Reproducible round-robin over the active pool, respecting capacity; falls back to the queue", tag: "CRM", permission: "crm:manage",
    pathParams: ["id"], success: { status: 200, schema: C.OpportunityDto, description: "Updated" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/routing/settings", id: "getRoutingSettings", summary: "Routing strategy and first-response SLA", tag: "CRM", permission: "crm:manage",
    success: { status: 200, schema: C.RoutingSettingsDto, description: "Settings" }, errors: [401, 403],
  },
  {
    method: "put", path: "/routing/settings", id: "setRoutingSettings", summary: "Set the strategy and optional SLA (no SLA until set)", tag: "CRM", permission: "crm:manage",
    body: C.RoutingSettingsRequest, success: { status: 200, schema: C.RoutingSettingsDto, description: "Settings" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/routing/pool", id: "listRoutingPool", summary: "Sellers eligible for assignment with their load", tag: "CRM", permission: "crm:manage",
    success: { status: 200, schema: C.PoolDto, description: "Pool" }, errors: [401, 403],
  },
  {
    method: "put", path: "/routing/pool/{userId}", id: "setPoolMember", summary: "Add or update a pool member (active seller, sales manager or admin)", tag: "CRM", permission: "crm:manage",
    pathParams: ["userId"], body: C.PoolMemberRequest, success: { status: 200, schema: C.PoolMemberDto, description: "Member" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "delete", path: "/routing/pool/{userId}", id: "removePoolMember", summary: "Remove a pool member", tag: "CRM", permission: "crm:manage",
    pathParams: ["userId"], success: { status: 204, description: "Removed" }, errors: [400, 401, 403, 404],
  },
  {
    method: "get", path: "/quotes", id: "listQuotes", summary: "Quotes (visibility follows the opportunity: sellers see only theirs)", tag: "Quotes", permission: "quotes:read",
    query: C.QuoteListQuery, success: { status: 200, schema: C.QuotePageDto, description: "Page" }, errors: [400, 401, 403],
  },
  {
    method: "post", path: "/quotes", id: "createQuote", summary: "Create a draft for an open opportunity from an APPROVED price list (currency comes from the list)", tag: "Quotes", permission: "quotes:manage",
    body: C.CreateQuoteRequest, success: { status: 201, schema: C.QuoteDetailDto, description: "Created" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/quotes/settings", id: "getQuoteSettings", summary: "Discount limit that needs no approval", tag: "Quotes", permission: "quotes:read",
    success: { status: 200, schema: C.QuoteSettingsDto, description: "Settings" }, errors: [401, 403],
  },
  {
    method: "put", path: "/quotes/settings", id: "setQuoteSettings", summary: "Set the discount limit (org_admin). Default 0: every discount needs approval", tag: "Quotes", permission: "quotes:approve",
    body: C.SetQuoteSettingsRequest, success: { status: 200, schema: C.QuoteSettingsDto, description: "Settings" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/quotes/{id}", id: "getQuote", summary: "Quote with its lines and evidence refs", tag: "Quotes", permission: "quotes:read",
    pathParams: ["id"], success: { status: 200, schema: C.QuoteDetailDto, description: "Quote" }, errors: [400, 401, 403, 404],
  },
  {
    method: "get", path: "/quotes/{id}/pdf", id: "downloadQuotePdf", summary: "PDF of the quote (server-computed amounts, no-store, audited)", tag: "Quotes", permission: "quotes:read",
    pathParams: ["id"], success: { status: 200, description: "application/pdf attachment" }, errors: [400, 401, 403, 404],
  },
  {
    method: "patch", path: "/quotes/{id}", id: "updateQuote", summary: "Edit validity, tax rate or notes of a draft", tag: "Quotes", permission: "quotes:manage",
    pathParams: ["id"], body: C.UpdateQuoteRequest, success: { status: 200, schema: C.QuoteDetailDto, description: "Quote" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/quotes/{id}/lines", id: "addQuoteLine", summary: "Add a SKU from approved evidence (price snapshot, exact decimal totals); 409 with reasons when there is no evidence", tag: "Quotes", permission: "quotes:manage",
    pathParams: ["id"], body: C.AddQuoteLineRequest, success: { status: 201, schema: C.QuoteDetailDto, description: "Quote" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "delete", path: "/quotes/{id}/lines/{lineId}", id: "removeQuoteLine", summary: "Remove a line from a draft (withdraws any discount approval)", tag: "Quotes", permission: "quotes:manage",
    pathParams: ["id", "lineId"], success: { status: 200, schema: C.QuoteDetailDto, description: "Quote" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/quotes/{id}/approve-discount", id: "approveQuoteDiscount", summary: "Approve the discounts of the current lines (org_admin)", tag: "Quotes", permission: "quotes:approve",
    pathParams: ["id"], success: { status: 200, schema: C.QuoteDetailDto, description: "Quote" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/quotes/{id}/send", id: "sendQuote", summary: "Freeze the quote: re-verifies evidence, totals and discount approval; advances the opportunity to quote_sent when allowed", tag: "Quotes", permission: "quotes:manage",
    pathParams: ["id"], success: { status: 200, schema: C.QuoteDetailDto, description: "Quote" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/quotes/{id}/decision", id: "decideQuote", summary: "Accept (creates the sale and wins the opportunity), reject or cancel", tag: "Quotes", permission: "quotes:manage",
    pathParams: ["id"], body: C.QuoteDecisionRequest, success: { status: 200, schema: C.QuoteDetailDto, description: "Quote" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/sales", id: "listSales", summary: "Sales (accepted quotes), linking lead, opportunity and quote", tag: "Quotes", permission: "quotes:read",
    query: C.PageQuery, success: { status: 200, schema: C.SalePageDto, description: "Page" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/analytics/overview", id: "getAnalyticsOverview", summary: "Funnel, pipeline, SLA, outcomes, sales and their reconciliation for a UTC window, with every definition", tag: "Analytics", permission: "analytics:read",
    query: C.AnalyticsQuery, success: { status: 200, schema: C.AnalyticsOverviewDto, description: "Metrics" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/attribution/campaigns", id: "getCampaignAttribution", summary: "Last-touch attribution of leads, opportunities and sales to campaigns (explicit model and lookback), reconciled with analytics", tag: "Analytics", permission: "analytics:read",
    query: C.AttributionQuery, success: { status: 200, schema: C.AttributionReportDto, description: "Attribution" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/attribution/cohorts", id: "getProspectCohorts", summary: "Monthly prospect cohorts: conversion to lead, opportunity and sale by age", tag: "Analytics", permission: "analytics:read",
    query: C.CohortsQuery, success: { status: 200, schema: C.CohortsReportDto, description: "Cohorts" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/analytics/events", id: "listAnalyticsEvents", summary: "Drill-down: the business records behind a metric (keyset by id)", tag: "Analytics", permission: "analytics:read",
    query: C.AnalyticsEventsQuery, success: { status: 200, schema: C.AnalyticsEventPageDto, description: "Page of events" }, errors: [400, 401, 403],
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
    method: "put", path: "/privacy/retention", id: "setRetention", summary: "Set per-class retention days (org_admin); 0 disables a class. Without a policy the default applies", tag: "Privacy", permission: "privacy:manage",
    body: C.SetRetentionRequest, success: { status: 200, schema: C.RetentionPolicyDto, description: "Policies" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/privacy/retention", id: "getRetention", summary: "Current retention policies", tag: "Privacy", permission: "privacy:manage",
    success: { status: 200, schema: C.RetentionPolicyDto, description: "Policies" }, errors: [401, 403],
  },
  {
    method: "post", path: "/privacy/retention/run", id: "runRetention", summary: "Purge expired rows per class (organization policy or default; disabled classes are skipped); dryRun (default) only reports", tag: "Privacy", permission: "privacy:manage",
    body: C.RetentionRunRequest, success: { status: 200, schema: C.RetentionRunDto, description: "Report" }, errors: [400, 401, 403],
  },
  {
    method: "post", path: "/privacy/requests", id: "createPrivacyRequest", summary: "Open a data-subject request (access, restrict, erase) about a contact", tag: "Privacy", permission: "privacy:manage",
    body: C.CreatePrivacyRequest, success: { status: 201, schema: C.PrivacyRequestDto, description: "Created" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/privacy/requests", id: "listPrivacyRequests", summary: "Data-subject requests, newest first", tag: "Privacy", permission: "privacy:manage",
    query: C.PrivacyListQuery, success: { status: 200, schema: C.PrivacyRequestListDto, description: "Requests" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/privacy/requests/{id}", id: "getPrivacyRequest", summary: "One data-subject request", tag: "Privacy", permission: "privacy:manage",
    pathParams: ["id"], success: { status: 200, schema: C.PrivacyRequestDto, description: "Request" }, errors: [400, 401, 403, 404],
  },
  {
    method: "post", path: "/privacy/requests/{id}/complete", id: "completePrivacyRequest", summary: "Apply the request atomically: access returns the package, restrict blocks all sending, erase anonymizes irreversibly. 409 if not open", tag: "Privacy", permission: "privacy:manage",
    pathParams: ["id"], success: { status: 200, schema: C.PrivacyRequestDto, description: "Completed" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/privacy/requests/{id}/reject", id: "rejectPrivacyRequest", summary: "Reject an open request with a reason", tag: "Privacy", permission: "privacy:manage",
    pathParams: ["id"], body: C.PrivacyNoteRequest, success: { status: 200, schema: C.PrivacyRequestDto, description: "Rejected" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/privacy/contacts/{id}/lift-restriction", id: "liftContactRestriction", summary: "Lift a restriction (org_admin, audited with its reason); erased contacts can never be restored", tag: "Privacy", permission: "privacy:manage",
    pathParams: ["id"], body: C.PrivacyNoteRequest, success: { status: 200, schema: C.ContactDto, description: "Contact" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/audit-events", id: "listAuditEvents", summary: "Most recent audit events of the caller's organization", tag: "Audit", permission: "audit:read",
    query: C.AuditQuery, success: { status: 200, schema: z.array(C.AuditEventDto), description: "Events" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/contacts/{id}/outreach-context", id: "getOutreachContext", summary: "What a drafter may use for one contact: per-channel eligibility, masked contact, prospect basics, approved evidence and length limits (no internal notes)", tag: "Drafts", permission: "campaigns:read",
    pathParams: ["id"], success: { status: 200, schema: C.OutreachContextDto, description: "Context" }, errors: [400, 401, 403, 404],
  },
  {
    method: "get", path: "/campaigns/{id}/sequence", id: "getCampaignSequence", summary: "Sequence of a campaign: sending window, time zone and chained steps", tag: "Sequences", permission: "campaigns:read",
    pathParams: ["id"], success: { status: 200, schema: C.SequenceDto, description: "Sequence (configured=false when none)" }, errors: [400, 401, 403, 404],
  },
  {
    method: "put", path: "/campaigns/{id}/sequence", id: "saveCampaignSequence", summary: "Replace the sequence (draft campaigns only, so approval covers the exact content)", tag: "Sequences", permission: "campaigns:manage",
    pathParams: ["id"], body: C.SaveSequenceRequest, success: { status: 200, schema: C.SequenceDto, description: "Saved" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/campaigns/{id}/sequence/enroll", id: "enrollCampaignSequence", summary: "Enrol every currently eligible contact of a running campaign (consent, opt-out, suppression and frequency cap apply)", tag: "Sequences", permission: "campaigns:manage",
    pathParams: ["id"], success: { status: 200, schema: C.EnrollResultDto, description: "Enrolment summary" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/admin/jobs", id: "listJobs", summary: "Worker jobs of the organization (default: the dead-letter queue). Errors are redacted; keyset by id", tag: "Jobs", permission: "jobs:manage",
    query: C.JobListQuery, success: { status: 200, schema: C.JobPageDto, description: "Page" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/admin/jobs/stats", id: "jobStats", summary: "Job counts by state for the organization", tag: "Jobs", permission: "jobs:manage",
    success: { status: 200, schema: C.JobStatsDto, description: "Counts" }, errors: [401, 403],
  },
  {
    method: "post", path: "/admin/jobs/{id}/requeue", id: "requeueJob", summary: "Put a dead or failed job back in the queue with a fresh attempt budget (audited). The job re-runs the same idempotent work", tag: "Jobs", permission: "jobs:manage",
    pathParams: ["id"], success: { status: 200, schema: C.JobDto, description: "Requeued job" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/campaigns/{id}/sequence/enrollments", id: "listSequenceEnrollments", summary: "Enrolments with their deliveries (keyset by id)", tag: "Sequences", permission: "campaigns:read",
    pathParams: ["id"], query: C.EnrollmentListQuery, success: { status: 200, schema: C.EnrollmentPageDto, description: "Page" }, errors: [400, 401, 403, 404],
  },
  {
    method: "post", path: "/message-drafts", id: "createMessageDraft", summary: "Create a personalised email or WhatsApp-template draft for human review (needs an eligible contact and approved evidence; never sends)", tag: "Drafts", permission: "campaigns:manage",
    body: C.CreateDraftRequest, success: { status: 201, schema: C.MessageDraftDto, description: "Created, pending review" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "get", path: "/message-drafts", id: "listMessageDrafts", summary: "Drafts (keyset by id), filterable by status and contact", tag: "Drafts", permission: "campaigns:read",
    query: C.DraftListQuery, success: { status: 200, schema: C.MessageDraftPageDto, description: "Page" }, errors: [400, 401, 403],
  },
  {
    method: "get", path: "/message-drafts/{id}", id: "getMessageDraft", summary: "One draft", tag: "Drafts", permission: "campaigns:read",
    pathParams: ["id"], success: { status: 200, schema: C.MessageDraftDto, description: "Draft" }, errors: [400, 401, 403, 404],
  },
  {
    method: "get", path: "/message-drafts/{id}/delivery", id: "getDraftDelivery", summary: "Delivery state of a draft (none until someone asks to send it)", tag: "Drafts", permission: "campaigns:read",
    pathParams: ["id"], success: { status: 200, schema: C.DraftDeliveryDto, description: "Delivery" }, errors: [400, 401, 403, 404],
  },
  {
    method: "post", path: "/message-drafts/{id}/send", id: "sendMessageDraft", summary: "Queue an approved email draft for delivery by the worker (nothing is sent inside this request)", tag: "Drafts", permission: "campaigns:approve",
    pathParams: ["id"], success: { status: 200, schema: C.DraftDeliveryDto, description: "Queued" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/message-drafts/{id}/approve", id: "approveMessageDraft", summary: "Approve a pending draft (re-checks eligibility; org_admin, sales_manager). Approving never sends", tag: "Drafts", permission: "campaigns:approve",
    pathParams: ["id"], success: { status: 200, schema: C.MessageDraftDto, description: "Approved" }, errors: [400, 401, 403, 404, 409],
  },
  {
    method: "post", path: "/message-drafts/{id}/reject", id: "rejectMessageDraft", summary: "Reject a pending draft with a note", tag: "Drafts", permission: "campaigns:approve",
    pathParams: ["id"], body: C.RejectDraftRequest, success: { status: 200, schema: C.MessageDraftDto, description: "Rejected" }, errors: [400, 401, 403, 404, 409],
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

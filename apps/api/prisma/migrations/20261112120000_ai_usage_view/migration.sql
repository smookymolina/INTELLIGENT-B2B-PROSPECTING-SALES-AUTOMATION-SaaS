-- MCP usage metadata (tool, outcome, who, when). Never content or PII. Plus an internal monthly call limit per organization (0 = no limit).
CREATE TABLE "mcp_usage_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tool" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mcp_usage_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mcp_usage_events_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "mcp_usage_events_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT mcp_usage_tool CHECK (tool IN ('get_outreach_context', 'save_message_draft', 'get_draft_status')),
    CONSTRAINT mcp_usage_outcome CHECK (outcome IN ('ok', 'error'))
);
CREATE INDEX "mcp_usage_events_org_created_idx" ON "mcp_usage_events" ("organization_id", "created_at");

CREATE TABLE "mcp_limits" (
    "organization_id" UUID NOT NULL,
    "monthly_limit" INTEGER NOT NULL,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mcp_limits_pkey" PRIMARY KEY ("organization_id"),
    CONSTRAINT "mcp_limits_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT mcp_limit_range CHECK (monthly_limit >= 0 AND monthly_limit <= 100000000)
);

ALTER TABLE mcp_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_usage_events FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_limits FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON mcp_usage_events TO app_runtime;
CREATE POLICY mcp_usage_select ON mcp_usage_events FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY mcp_usage_insert ON mcp_usage_events FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_can_use_ai() AND user_id = app_current_user());

GRANT SELECT, INSERT ON mcp_limits TO app_runtime;
GRANT UPDATE (monthly_limit, updated_by, updated_at) ON mcp_limits TO app_runtime;
CREATE POLICY mcp_limits_select ON mcp_limits FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY mcp_limits_insert ON mcp_limits FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_current_role() = 'org_admin' AND updated_by = app_current_user());
CREATE POLICY mcp_limits_update ON mcp_limits FOR UPDATE TO app_runtime USING (organization_id = app_current_org() AND app_current_role() = 'org_admin') WITH CHECK (organization_id = app_current_org() AND updated_by = app_current_user());

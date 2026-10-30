-- CreateTable
CREATE TABLE "ai_budgets" (
    "organization_id" UUID NOT NULL,
    "monthly_limit_micros" BIGINT NOT NULL,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_budgets_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "ai_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "capability" TEXT NOT NULL,
    "prompt_key" TEXT NOT NULL,
    "prompt_version" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "evidence_refs" TEXT[],
    "flags" TEXT[],
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DECIMAL(4,3),
    "output" JSONB,
    "request_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_runs_organization_id_created_at_idx" ON "ai_runs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_runs_organization_id_needs_review_created_at_idx" ON "ai_runs"("organization_id", "needs_review", "created_at");

-- AddForeignKey
ALTER TABLE "ai_budgets" ADD CONSTRAINT "ai_budgets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- AI gateway: budgets (org_admin writes) and an append-only run ledger (who may use AI is decided in the API by ai:use; the database also
-- limits inserts to the roles that hold it, and nobody can edit or delete a run).
ALTER TABLE ai_budgets ADD CONSTRAINT ai_budget_nonneg CHECK (monthly_limit_micros >= 0 AND monthly_limit_micros <= 1000000000000);
ALTER TABLE ai_runs ADD CONSTRAINT ai_run_status CHECK (status IN ('ok', 'needs_review', 'blocked', 'budget_exceeded', 'provider_error', 'schema_invalid'));
ALTER TABLE ai_runs ADD CONSTRAINT ai_run_nonneg CHECK (input_tokens >= 0 AND output_tokens >= 0 AND cost_micros >= 0 AND latency_ms >= 0);
ALTER TABLE ai_runs ADD CONSTRAINT ai_run_confidence CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1);
ALTER TABLE ai_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_runs ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION app_can_use_ai() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT app_current_role() IN ('org_admin', 'sales_manager', 'campaign_manager', 'seller') $$;
GRANT EXECUTE ON FUNCTION app_can_use_ai() TO app_runtime;

GRANT SELECT, INSERT ON ai_budgets TO app_runtime;
GRANT UPDATE (monthly_limit_micros, updated_by, updated_at) ON ai_budgets TO app_runtime;
CREATE POLICY ai_budgets_select ON ai_budgets FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY ai_budgets_insert ON ai_budgets FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_current_role() = 'org_admin' AND updated_by = app_current_user());
CREATE POLICY ai_budgets_update ON ai_budgets FOR UPDATE TO app_runtime USING (organization_id = app_current_org() AND app_current_role() = 'org_admin') WITH CHECK (organization_id = app_current_org() AND updated_by = app_current_user());

GRANT SELECT, INSERT ON ai_runs TO app_runtime;
CREATE POLICY ai_runs_select ON ai_runs FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY ai_runs_insert ON ai_runs FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_can_use_ai() AND user_id = app_current_user());

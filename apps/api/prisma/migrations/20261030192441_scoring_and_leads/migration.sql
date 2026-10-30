-- CreateTable
CREATE TABLE "prospect_attributes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "value_key" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unverified',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),

    CONSTRAINT "prospect_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scoring_model_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "rules" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),

    CONSTRAINT "scoring_model_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "score_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "model_version_id" UUID NOT NULL,
    "total" INTEGER NOT NULL,
    "breakdown" JSONB NOT NULL,
    "computed_by" UUID NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "score_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_settings" (
    "organization_id" UUID NOT NULL,
    "min_score" INTEGER NOT NULL,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "origin" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending_review',
    "open_key" TEXT,
    "score_result_id" UUID,
    "assessment_id" UUID,
    "min_score" INTEGER,
    "review_note" TEXT,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intent_assessments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "excerpt" TEXT NOT NULL,
    "text_hash" TEXT NOT NULL,
    "classifier_version" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "matched" JSONB NOT NULL,
    "ambiguous" BOOLEAN NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intent_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prospect_attributes_organization_id_prospect_id_idx" ON "prospect_attributes"("organization_id", "prospect_id");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_attributes_prospect_id_key_value_key_key" ON "prospect_attributes"("prospect_id", "key", "value_key");

-- CreateIndex
CREATE UNIQUE INDEX "scoring_model_versions_organization_id_version_key" ON "scoring_model_versions"("organization_id", "version");

-- CreateIndex
CREATE INDEX "score_results_organization_id_prospect_id_computed_at_idx" ON "score_results"("organization_id", "prospect_id", "computed_at" DESC);

-- CreateIndex
CREATE INDEX "leads_organization_id_state_idx" ON "leads"("organization_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "leads_organization_id_open_key_key" ON "leads"("organization_id", "open_key");

-- CreateIndex
CREATE INDEX "intent_assessments_organization_id_prospect_id_created_at_idx" ON "intent_assessments"("organization_id", "prospect_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "prospect_attributes" ADD CONSTRAINT "prospect_attributes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_attributes" ADD CONSTRAINT "prospect_attributes_organization_id_prospect_id_fkey" FOREIGN KEY ("organization_id", "prospect_id") REFERENCES "prospects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoring_model_versions" ADD CONSTRAINT "scoring_model_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "score_results" ADD CONSTRAINT "score_results_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "score_results" ADD CONSTRAINT "score_results_organization_id_prospect_id_fkey" FOREIGN KEY ("organization_id", "prospect_id") REFERENCES "prospects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "score_results" ADD CONSTRAINT "score_results_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "scoring_model_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_settings" ADD CONSTRAINT "lead_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_prospect_id_fkey" FOREIGN KEY ("organization_id", "prospect_id") REFERENCES "prospects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intent_assessments" ADD CONSTRAINT "intent_assessments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intent_assessments" ADD CONSTRAINT "intent_assessments_organization_id_prospect_id_fkey" FOREIGN KEY ("organization_id", "prospect_id") REFERENCES "prospects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

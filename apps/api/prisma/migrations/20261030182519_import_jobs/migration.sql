-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "total_rows" INTEGER NOT NULL,
    "created_count" INTEGER NOT NULL,
    "updated_count" INTEGER NOT NULL,
    "unchanged_count" INTEGER NOT NULL,
    "error_count" INTEGER NOT NULL,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_jobs_organization_id_created_at_idx" ON "import_jobs"("organization_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Import jobs (P3-04): immutable audit-like record; only catalog managers can write; no UPDATE/DELETE grants.
ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs
  ADD CONSTRAINT import_jobs_kind CHECK (kind IN ('catalog_items')),
  ADD CONSTRAINT import_jobs_mode CHECK (mode IN ('dry_run', 'apply')),
  ADD CONSTRAINT import_jobs_status CHECK (status IN ('valid', 'invalid', 'applied', 'rejected')),
  ADD CONSTRAINT import_jobs_counts CHECK (total_rows >= 0 AND created_count >= 0 AND updated_count >= 0 AND unchanged_count >= 0 AND error_count >= 0),
  ADD CONSTRAINT import_jobs_hash CHECK (file_hash ~ '^[0-9a-f]{64}$');
GRANT SELECT, INSERT ON import_jobs TO app_runtime;
CREATE POLICY import_jobs_select ON import_jobs FOR SELECT TO app_runtime USING (organization_id = app_current_org() AND app_can_manage_catalog());
CREATE POLICY import_jobs_insert ON import_jobs FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_catalog() AND created_by = app_current_user());

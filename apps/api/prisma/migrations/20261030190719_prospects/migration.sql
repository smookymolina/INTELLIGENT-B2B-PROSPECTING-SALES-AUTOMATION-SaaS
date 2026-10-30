-- CreateEnum
CREATE TYPE "prospect_status" AS ENUM ('candidate', 'qualified', 'disqualified');

-- CreateTable
CREATE TABLE "prospects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "domain_key" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "website" TEXT,
    "country" CHAR(2),
    "region" TEXT,
    "city" TEXT,
    "industry" TEXT,
    "notes" TEXT,
    "status" "prospect_status" NOT NULL DEFAULT 'candidate',
    "status_reason" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "prospects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_ref" TEXT,
    "created_by" UUID NOT NULL,
    "collected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppressions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "value_key" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prospects_organization_id_status_idx" ON "prospects"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "prospects_organization_id_id_key" ON "prospects"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "prospects_organization_id_dedupe_key_key" ON "prospects"("organization_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "prospect_sources_organization_id_prospect_id_idx" ON "prospect_sources"("organization_id", "prospect_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppressions_organization_id_kind_value_key_key" ON "suppressions"("organization_id", "kind", "value_key");

-- AddForeignKey
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_sources" ADD CONSTRAINT "prospect_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_sources" ADD CONSTRAINT "prospect_sources_organization_id_prospect_id_fkey" FOREIGN KEY ("organization_id", "prospect_id") REFERENCES "prospects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prospects (P4-01). A prospect is a candidate company, never a permission to contact. Tenant-scoped RLS; the do-not-contact list is
-- enforced by triggers so no code path can qualify a suppressed prospect.
ALTER TABLE prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppressions ENABLE ROW LEVEL SECURITY;

ALTER TABLE prospects
  ADD CONSTRAINT prospects_country_fmt CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT prospects_domain_fmt CHECK (domain_key IS NULL OR (domain_key ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' AND length(domain_key) <= 253)),
  ADD CONSTRAINT prospects_dedupe_consistent CHECK (dedupe_key = COALESCE(domain_key, name_key || '|' || COALESCE(country, ''))),
  ADD CONSTRAINT prospects_name_key_nonempty CHECK (length(name_key) > 0);
ALTER TABLE prospect_sources ADD CONSTRAINT prospect_sources_type CHECK (source_type IN ('manual', 'csv_import'));
ALTER TABLE suppressions
  ADD CONSTRAINT suppressions_kind CHECK (kind IN ('domain', 'name')),
  ADD CONSTRAINT suppressions_value_nonempty CHECK (length(value_key) > 0 AND length(reason) > 0);
ALTER TABLE import_jobs DROP CONSTRAINT import_jobs_kind;
ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_kind CHECK (kind IN ('catalog_items', 'prospects'));

CREATE FUNCTION app_can_manage_prospects() RETURNS boolean LANGUAGE sql STABLE
AS $$ SELECT app_current_role() IN ('org_admin', 'sales_manager', 'campaign_manager') $$;
CREATE FUNCTION app_can_manage_suppressions() RETURNS boolean LANGUAGE sql STABLE
AS $$ SELECT app_current_role() IN ('org_admin', 'sales_manager', 'campaign_manager') $$;
GRANT EXECUTE ON FUNCTION app_can_manage_prospects(), app_can_manage_suppressions() TO app_runtime;

-- prospects
GRANT SELECT, INSERT ON prospects TO app_runtime;
GRANT UPDATE (name, name_key, domain_key, dedupe_key, website, country, region, city, industry, notes, status, status_reason, updated_at) ON prospects TO app_runtime;
CREATE POLICY prospects_select ON prospects FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY prospects_insert ON prospects FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_prospects() AND created_by = app_current_user());
CREATE POLICY prospects_update ON prospects FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_can_manage_prospects()) WITH CHECK (organization_id = app_current_org());

CREATE FUNCTION prospects_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'qualified' AND EXISTS (
    SELECT 1 FROM suppressions s WHERE s.organization_id = NEW.organization_id
      AND ((s.kind = 'domain' AND s.value_key = NEW.domain_key) OR (s.kind = 'name' AND s.value_key = NEW.name_key))
  ) THEN
    RAISE EXCEPTION 'a suppressed prospect cannot be qualified' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prospects_guard BEFORE INSERT OR UPDATE ON prospects FOR EACH ROW EXECUTE FUNCTION prospects_guard();

-- provenance: append-only
GRANT SELECT, INSERT ON prospect_sources TO app_runtime;
CREATE POLICY prospect_sources_select ON prospect_sources FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY prospect_sources_insert ON prospect_sources FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_prospects() AND created_by = app_current_user());

-- do-not-contact list
GRANT SELECT, INSERT, DELETE ON suppressions TO app_runtime;
CREATE POLICY suppressions_select ON suppressions FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY suppressions_insert ON suppressions FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_suppressions() AND created_by = app_current_user());
CREATE POLICY suppressions_delete ON suppressions FOR DELETE TO app_runtime
  USING (organization_id = app_current_org() AND app_current_role() = 'org_admin');

-- Adding a suppression immediately withdraws qualification from matching prospects.
CREATE FUNCTION suppressions_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE prospects p SET status = 'disqualified', status_reason = 'suppressed', updated_at = now()
   WHERE p.organization_id = NEW.organization_id AND p.status = 'qualified'
     AND ((NEW.kind = 'domain' AND p.domain_key = NEW.value_key) OR (NEW.kind = 'name' AND p.name_key = NEW.value_key));
  RETURN NEW;
END $$;
CREATE TRIGGER suppressions_apply AFTER INSERT ON suppressions FOR EACH ROW EXECUTE FUNCTION suppressions_apply();

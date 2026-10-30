-- CreateTable
CREATE TABLE "organization_profiles" (
    "organization_id" UUID NOT NULL,
    "legal_name" TEXT,
    "trade_name" TEXT,
    "industry" TEXT,
    "website" TEXT,
    "description" TEXT,
    "country" CHAR(2),
    "timezone" TEXT,
    "default_currency" CHAR(3),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organization_profiles_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "region" TEXT,
    "country" CHAR(2),
    "status" "record_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "branches_organization_id_name_key_key" ON "branches"("organization_id", "name_key");

-- AddForeignKey
ALTER TABLE "organization_profiles" ADD CONSTRAINT "organization_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Company profile + branches (P3-01): tenant-scoped, writes require org_admin, organization_id immutable (column grants), no DELETE.
ALTER TABLE organization_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_profiles
  ADD CONSTRAINT organization_profiles_country_fmt CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT organization_profiles_currency_fmt CHECK (default_currency IS NULL OR default_currency ~ '^[A-Z]{3}$');
ALTER TABLE branches ADD CONSTRAINT branches_country_fmt CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');

GRANT SELECT, INSERT ON organization_profiles TO app_runtime;
GRANT UPDATE (legal_name, trade_name, industry, website, description, country, timezone, default_currency, updated_at) ON organization_profiles TO app_runtime;
CREATE POLICY organization_profiles_select ON organization_profiles FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY organization_profiles_insert ON organization_profiles FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_current_role() = 'org_admin');
CREATE POLICY organization_profiles_update ON organization_profiles FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_current_role() = 'org_admin')
  WITH CHECK (organization_id = app_current_org());

GRANT SELECT, INSERT ON branches TO app_runtime;
GRANT UPDATE (name, name_key, address, city, region, country, status, updated_at) ON branches TO app_runtime;
CREATE POLICY branches_select ON branches FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY branches_insert ON branches FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_current_role() = 'org_admin');
CREATE POLICY branches_update ON branches FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_current_role() = 'org_admin')
  WITH CHECK (organization_id = app_current_org());

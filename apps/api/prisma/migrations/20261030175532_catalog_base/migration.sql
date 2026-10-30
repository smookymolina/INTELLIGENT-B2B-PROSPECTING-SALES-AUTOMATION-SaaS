-- CreateEnum
CREATE TYPE "catalog_item_kind" AS ENUM ('product', 'service');

-- CreateEnum
CREATE TYPE "catalog_version_state" AS ENUM ('draft', 'approved', 'superseded');

-- CreateTable
CREATE TABLE "catalog_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "status" "record_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "catalog_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "kind" "catalog_item_kind" NOT NULL,
    "sku" TEXT NOT NULL,
    "sku_key" TEXT NOT NULL,
    "latest_version" INTEGER NOT NULL DEFAULT 1,
    "approved_version" INTEGER,
    "archived_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_item_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "state" "catalog_version_state" NOT NULL DEFAULT 'draft',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unit" TEXT,
    "features" JSONB NOT NULL DEFAULT '[]',
    "category_id" UUID,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_item_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "catalog_categories_organization_id_name_key_key" ON "catalog_categories"("organization_id", "name_key");

-- CreateIndex
CREATE INDEX "catalog_items_organization_id_created_at_id_idx" ON "catalog_items"("organization_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "catalog_items_organization_id_id_key" ON "catalog_items"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_items_organization_id_sku_key_key" ON "catalog_items"("organization_id", "sku_key");

-- CreateIndex
CREATE INDEX "catalog_item_versions_organization_id_item_id_idx" ON "catalog_item_versions"("organization_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_item_versions_item_id_version_key" ON "catalog_item_versions"("item_id", "version");

-- AddForeignKey
ALTER TABLE "catalog_categories" ADD CONSTRAINT "catalog_categories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item_versions" ADD CONSTRAINT "catalog_item_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item_versions" ADD CONSTRAINT "catalog_item_versions_organization_id_item_id_fkey" FOREIGN KEY ("organization_id", "item_id") REFERENCES "catalog_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item_versions" ADD CONSTRAINT "catalog_item_versions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "catalog_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Catalog base (P3-02). Tenant-scoped RLS; writes need org_admin or sales_manager; approving/archiving/superseding needs org_admin.
-- Approved content is immutable (trigger). No DELETE grants anywhere: catalog history is permanent.
ALTER TABLE catalog_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_item_versions ENABLE ROW LEVEL SECURITY;

ALTER TABLE catalog_items
  ADD CONSTRAINT catalog_items_sku_fmt CHECK (sku ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' AND sku_key = lower(sku)),
  ADD CONSTRAINT catalog_items_versions_pos CHECK (latest_version >= 1 AND (approved_version IS NULL OR approved_version BETWEEN 1 AND latest_version));
ALTER TABLE catalog_item_versions
  ADD CONSTRAINT catalog_versions_number_pos CHECK (version >= 1),
  ADD CONSTRAINT catalog_versions_features_array CHECK (jsonb_typeof(features) = 'array' AND jsonb_array_length(features) <= 50),
  ADD CONSTRAINT catalog_versions_approval_consistent CHECK ((state = 'draft') = (approved_by IS NULL AND approved_at IS NULL) OR state = 'superseded');

CREATE FUNCTION app_can_manage_catalog() RETURNS boolean LANGUAGE sql STABLE
AS $$ SELECT app_current_role() IN ('org_admin', 'sales_manager') $$;
GRANT EXECUTE ON FUNCTION app_can_manage_catalog() TO app_runtime;

-- categories
GRANT SELECT, INSERT ON catalog_categories TO app_runtime;
GRANT UPDATE (name, name_key, status, updated_at) ON catalog_categories TO app_runtime;
CREATE POLICY catalog_categories_select ON catalog_categories FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY catalog_categories_insert ON catalog_categories FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_can_manage_catalog());
CREATE POLICY catalog_categories_update ON catalog_categories FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_can_manage_catalog()) WITH CHECK (organization_id = app_current_org());

-- items (header)
GRANT SELECT, INSERT ON catalog_items TO app_runtime;
GRANT UPDATE (latest_version, approved_version, archived_at, updated_at) ON catalog_items TO app_runtime;
CREATE POLICY catalog_items_select ON catalog_items FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY catalog_items_insert ON catalog_items FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_catalog() AND approved_version IS NULL AND archived_at IS NULL);
CREATE POLICY catalog_items_update ON catalog_items FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_can_manage_catalog()) WITH CHECK (organization_id = app_current_org());

CREATE FUNCTION catalog_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.approved_version IS DISTINCT FROM OLD.approved_version OR NEW.archived_at IS DISTINCT FROM OLD.archived_at)
     AND app_current_role() IS DISTINCT FROM 'org_admin' THEN
    RAISE EXCEPTION 'only org_admin can approve, archive or restore catalog items' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.approved_version IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM catalog_item_versions v WHERE v.item_id = NEW.id AND v.version = NEW.approved_version AND v.state = 'approved'
  ) THEN
    RAISE EXCEPTION 'approved_version must point to an approved version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_items_guard BEFORE UPDATE ON catalog_items FOR EACH ROW EXECUTE FUNCTION catalog_items_guard();

-- versions
GRANT SELECT, INSERT ON catalog_item_versions TO app_runtime;
GRANT UPDATE (state, name, description, unit, features, category_id, approved_by, approved_at) ON catalog_item_versions TO app_runtime;
CREATE POLICY catalog_versions_select ON catalog_item_versions FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY catalog_versions_insert ON catalog_item_versions FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_catalog() AND state = 'draft');
CREATE POLICY catalog_versions_update ON catalog_item_versions FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_can_manage_catalog())
  WITH CHECK (organization_id = app_current_org() AND (state = 'draft' OR app_current_role() = 'org_admin'));

CREATE FUNCTION catalog_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Serialize per item and allow a single open draft.
    PERFORM 1 FROM catalog_items WHERE id = NEW.item_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM catalog_item_versions v WHERE v.item_id = NEW.item_id AND v.state = 'draft') THEN
      RAISE EXCEPTION 'item already has an open draft' USING ERRCODE = 'unique_violation';
    END IF;
  ELSE
    IF OLD.state <> 'draft' THEN
      IF NOT (OLD.state = 'approved' AND NEW.state = 'superseded') THEN
        RAISE EXCEPTION 'approved catalog versions are immutable' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF (NEW.name, NEW.description, NEW.unit, NEW.features, NEW.category_id, NEW.approved_by, NEW.approved_at)
         IS DISTINCT FROM (OLD.name, OLD.description, OLD.unit, OLD.features, OLD.category_id, OLD.approved_by, OLD.approved_at) THEN
        RAISE EXCEPTION 'approved catalog versions are immutable' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NEW.state = 'superseded' THEN
      RAISE EXCEPTION 'a draft cannot be superseded' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Category must belong to the same organization (RLS alone would let a guessed id pass the FK).
  IF NEW.category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM catalog_categories c WHERE c.id = NEW.category_id AND c.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'category belongs to another organization' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_versions_guard BEFORE INSERT OR UPDATE ON catalog_item_versions FOR EACH ROW EXECUTE FUNCTION catalog_versions_guard();

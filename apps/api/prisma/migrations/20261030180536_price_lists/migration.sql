-- CreateEnum
CREATE TYPE "price_list_status" AS ENUM ('draft', 'approved', 'archived');

-- CreateTable
CREATE TABLE "price_lists" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "price_list_status" NOT NULL DEFAULT 'draft',
    "valid_from" DATE,
    "valid_until" DATE,
    "cloned_from" UUID,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "price_list_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "price_list_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "price_lists_organization_id_id_key" ON "price_lists"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "price_lists_organization_id_name_key_key" ON "price_lists"("organization_id", "name_key");

-- CreateIndex
CREATE INDEX "price_list_entries_organization_id_item_id_idx" ON "price_list_entries"("organization_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_entries_price_list_id_item_id_key" ON "price_list_entries"("price_list_id", "item_id");

-- AddForeignKey
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_entries" ADD CONSTRAINT "price_list_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_entries" ADD CONSTRAINT "price_list_entries_organization_id_price_list_id_fkey" FOREIGN KEY ("organization_id", "price_list_id") REFERENCES "price_lists"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_entries" ADD CONSTRAINT "price_list_entries_organization_id_item_id_fkey" FOREIGN KEY ("organization_id", "item_id") REFERENCES "catalog_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Price lists (P3-03). Same permission model as the catalog: manage = org_admin + sales_manager, approve/archive = org_admin.
-- Approved lists are immutable; a list can be approved only if it has entries and every priced item is currently approved.
ALTER TABLE price_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_list_entries ENABLE ROW LEVEL SECURITY;

ALTER TABLE price_lists
  ADD CONSTRAINT price_lists_currency_fmt CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT price_lists_dates_ordered CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until >= valid_from),
  ADD CONSTRAINT price_lists_state_consistent CHECK (
    (status = 'draft' AND approved_at IS NULL AND archived_at IS NULL)
    OR (status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND archived_at IS NULL)
    OR (status = 'archived' AND archived_at IS NOT NULL));
ALTER TABLE price_list_entries ADD CONSTRAINT price_entries_non_negative CHECK (unit_price >= 0);

-- price_lists
GRANT SELECT, INSERT ON price_lists TO app_runtime;
GRANT UPDATE (name, name_key, valid_from, valid_until, status, approved_by, approved_at, archived_at, updated_at) ON price_lists TO app_runtime;
CREATE POLICY price_lists_select ON price_lists FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY price_lists_insert ON price_lists FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_catalog() AND status = 'draft');
CREATE POLICY price_lists_update ON price_lists FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_can_manage_catalog())
  WITH CHECK (organization_id = app_current_org() AND (status = 'draft' OR app_current_role() = 'org_admin'));

CREATE FUNCTION price_lists_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'archived' THEN
    RAISE EXCEPTION 'archived price lists are immutable' USING ERRCODE = 'insufficient_privilege';
  ELSIF OLD.status = 'approved' THEN
    IF NEW.status <> 'archived'
       OR (NEW.name, NEW.name_key, NEW.valid_from, NEW.valid_until, NEW.approved_by, NEW.approved_at)
          IS DISTINCT FROM (OLD.name, OLD.name_key, OLD.valid_from, OLD.valid_until, OLD.approved_by, OLD.approved_at) THEN
      RAISE EXCEPTION 'approved price lists are immutable (clone to change)' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.status = 'approved' THEN
    IF NOT EXISTS (SELECT 1 FROM price_list_entries e WHERE e.price_list_id = NEW.id) THEN
      RAISE EXCEPTION 'a price list needs at least one entry to be approved' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM price_list_entries e JOIN catalog_items i ON i.id = e.item_id
      WHERE e.price_list_id = NEW.id AND (i.approved_version IS NULL OR i.archived_at IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'every priced item must be approved and not archived' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER price_lists_guard BEFORE UPDATE ON price_lists FOR EACH ROW EXECUTE FUNCTION price_lists_guard();

-- entries: only while the list is a draft (share lock makes a concurrent approval wait, then reject the late edit)
GRANT SELECT, INSERT, DELETE ON price_list_entries TO app_runtime;
GRANT UPDATE (unit_price, updated_at) ON price_list_entries TO app_runtime;
CREATE POLICY price_entries_select ON price_list_entries FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY price_entries_insert ON price_list_entries FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_catalog());
CREATE POLICY price_entries_update ON price_list_entries FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_can_manage_catalog()) WITH CHECK (organization_id = app_current_org());
CREATE POLICY price_entries_delete ON price_list_entries FOR DELETE TO app_runtime
  USING (organization_id = app_current_org() AND app_can_manage_catalog());

CREATE FUNCTION price_entries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_list uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.price_list_id ELSE NEW.price_list_id END;
  v_status price_list_status;
BEGIN
  SELECT status INTO v_status FROM price_lists WHERE id = v_list FOR SHARE;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'prices can only change while the price list is a draft' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER price_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON price_list_entries FOR EACH ROW EXECUTE FUNCTION price_entries_guard();

-- Reversible duplicate merge: a non-destructive link (duplicate hidden behind a survivor). No child row (sources, attributes, scores,
-- leads, opportunities, contacts) is moved or deleted, so suppression, consent and provenance stay exactly where they were.
CREATE TABLE "prospect_merges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "survivor_id" UUID NOT NULL,
    "duplicate_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "merged_by" UUID NOT NULL,
    "merged_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reverted_by" UUID,
    "reverted_at" TIMESTAMPTZ(6),
    CONSTRAINT "prospect_merges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "prospect_merges_distinct" CHECK ("survivor_id" <> "duplicate_id"),
    CONSTRAINT "prospect_merges_reason_len" CHECK (char_length("reason") BETWEEN 1 AND 200),
    CONSTRAINT "prospect_merges_revert_pair" CHECK (("reverted_at" IS NULL) = ("reverted_by" IS NULL))
);
CREATE INDEX "prospect_merges_organization_id_survivor_id_idx" ON "prospect_merges"("organization_id", "survivor_id");
CREATE INDEX "prospect_merges_organization_id_duplicate_id_idx" ON "prospect_merges"("organization_id", "duplicate_id");
ALTER TABLE "prospect_merges" ADD CONSTRAINT "prospect_merges_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_merges" ADD CONSTRAINT "prospect_merges_survivor_fkey" FOREIGN KEY ("organization_id", "survivor_id") REFERENCES "prospects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_merges" ADD CONSTRAINT "prospect_merges_duplicate_fkey" FOREIGN KEY ("organization_id", "duplicate_id") REFERENCES "prospects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE prospect_merges ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON prospect_merges TO app_runtime;
GRANT UPDATE (reverted_by, reverted_at) ON prospect_merges TO app_runtime;
CREATE POLICY prospect_merges_select ON prospect_merges FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY prospect_merges_insert ON prospect_merges FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_can_manage_prospects() AND merged_by = app_current_user());
CREATE POLICY prospect_merges_update ON prospect_merges FOR UPDATE TO app_runtime USING (organization_id = app_current_org() AND app_can_manage_prospects()) WITH CHECK (organization_id = app_current_org() AND reverted_by = app_current_user());

-- Invariants in the database: one active merge per duplicate, no chains (a survivor is never itself a hidden duplicate and vice versa),
-- and the row is append-only apart from a single revert.
CREATE FUNCTION prospect_merges_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.reverted_at IS NOT NULL THEN RAISE EXCEPTION 'a merge starts active' USING ERRCODE = 'check_violation'; END IF;
    IF EXISTS (SELECT 1 FROM prospect_merges WHERE organization_id = NEW.organization_id AND duplicate_id = NEW.duplicate_id AND reverted_at IS NULL) THEN
      RAISE EXCEPTION 'prospect already merged into another' USING ERRCODE = 'unique_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM prospect_merges WHERE organization_id = NEW.organization_id AND duplicate_id = NEW.survivor_id AND reverted_at IS NULL)
       OR EXISTS (SELECT 1 FROM prospect_merges WHERE organization_id = NEW.organization_id AND survivor_id = NEW.duplicate_id AND reverted_at IS NULL) THEN
      RAISE EXCEPTION 'merge chains are not allowed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.reverted_at IS NOT NULL THEN RAISE EXCEPTION 'merge already reverted' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.survivor_id <> OLD.survivor_id OR NEW.duplicate_id <> OLD.duplicate_id
     OR NEW.reason <> OLD.reason OR NEW.merged_by <> OLD.merged_by OR NEW.merged_at <> OLD.merged_at OR NEW.reverted_at IS NULL THEN
    RAISE EXCEPTION 'a merge can only be reverted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prospect_merges_guard BEFORE INSERT OR UPDATE ON prospect_merges FOR EACH ROW EXECUTE FUNCTION prospect_merges_guard();

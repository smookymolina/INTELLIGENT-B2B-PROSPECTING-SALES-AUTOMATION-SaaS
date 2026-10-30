-- Enrichment attributes, scoring, intent assessments and leads (P5-01, P8-01). Tenant-scoped RLS; rules repeated as DB constraints and triggers.
ALTER TABLE prospect_attributes ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring_model_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE score_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE intent_assessments ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION app_can_manage_scoring() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT app_current_role() IN ('org_admin', 'sales_manager') $$;
CREATE FUNCTION app_can_review_leads() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT app_current_role() IN ('org_admin', 'sales_manager') $$;
CREATE FUNCTION app_is_org_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT app_current_role() = 'org_admin' $$;
GRANT EXECUTE ON FUNCTION app_can_manage_scoring(), app_can_review_leads(), app_is_org_admin() TO app_runtime;

ALTER TABLE prospect_attributes
  ADD CONSTRAINT prospect_attributes_key_fmt CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  ADD CONSTRAINT prospect_attributes_value_len CHECK (length(value) BETWEEN 1 AND 200 AND value_key = lower(btrim(value))),
  ADD CONSTRAINT prospect_attributes_confidence CHECK (confidence IN ('low', 'medium', 'high')),
  ADD CONSTRAINT prospect_attributes_source CHECK (source IN ('manual', 'csv_import')),
  ADD CONSTRAINT prospect_attributes_status CHECK (status IN ('unverified', 'verified', 'rejected')),
  ADD CONSTRAINT prospect_attributes_decision_consistent CHECK ((status = 'unverified') = (decided_at IS NULL AND decided_by IS NULL));
ALTER TABLE scoring_model_versions
  ADD CONSTRAINT scoring_versions_state CHECK (state IN ('draft', 'approved', 'superseded')),
  ADD CONSTRAINT scoring_versions_rules CHECK (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) <= 50),
  ADD CONSTRAINT scoring_versions_approval CHECK ((state = 'draft') = (approved_at IS NULL) OR state = 'superseded');
ALTER TABLE lead_settings ADD CONSTRAINT lead_settings_range CHECK (min_score BETWEEN -1000 AND 1000);
ALTER TABLE leads
  ADD CONSTRAINT leads_origin CHECK (origin IN ('rule', 'intent')),
  ADD CONSTRAINT leads_state CHECK (state IN ('pending_review', 'accepted', 'rejected')),
  ADD CONSTRAINT leads_open_key CHECK ((open_key IS NULL) = (state = 'rejected') AND (open_key IS NULL OR open_key = prospect_id::text)),
  ADD CONSTRAINT leads_evidence CHECK ((origin = 'rule' AND score_result_id IS NOT NULL AND min_score IS NOT NULL) OR (origin = 'intent' AND assessment_id IS NOT NULL)),
  ADD CONSTRAINT leads_review_consistent CHECK ((state = 'pending_review') = (reviewed_at IS NULL) OR review_note = 'suppressed');
ALTER TABLE intent_assessments
  ADD CONSTRAINT intent_class CHECK (class IN ('purchase', 'quote', 'info', 'call', 'future', 'no_interest', 'unsubscribe', 'auto_reply', 'irrelevant', 'review')),
  ADD CONSTRAINT intent_text_hash CHECK (text_hash ~ '^[0-9a-f]{64}$' AND length(excerpt) <= 1000);

-- attributes: written by prospect managers; after creation only the human decision changes
GRANT SELECT, INSERT ON prospect_attributes TO app_runtime;
GRANT UPDATE (status, decided_by, decided_at) ON prospect_attributes TO app_runtime;
CREATE POLICY prospect_attributes_select ON prospect_attributes FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY prospect_attributes_insert ON prospect_attributes FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_prospects() AND created_by = app_current_user() AND status = 'unverified');
CREATE POLICY prospect_attributes_update ON prospect_attributes FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_can_manage_prospects()) WITH CHECK (organization_id = app_current_org());

-- scoring model versions (same discipline as the catalog: one draft, approved is immutable)
GRANT SELECT, INSERT ON scoring_model_versions TO app_runtime;
GRANT UPDATE (rules, state, approved_by, approved_at) ON scoring_model_versions TO app_runtime;
CREATE POLICY scoring_versions_select ON scoring_model_versions FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY scoring_versions_insert ON scoring_model_versions FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_scoring() AND state = 'draft' AND created_by = app_current_user());
CREATE POLICY scoring_versions_update ON scoring_model_versions FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_can_manage_scoring())
  WITH CHECK (organization_id = app_current_org() AND (state = 'draft' OR app_is_org_admin()));

CREATE FUNCTION scoring_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('scoring:' || NEW.organization_id::text, 0));
    IF EXISTS (SELECT 1 FROM scoring_model_versions v WHERE v.organization_id = NEW.organization_id AND v.state = 'draft') THEN
      RAISE EXCEPTION 'the scoring model already has an open draft' USING ERRCODE = 'unique_violation';
    END IF;
  ELSIF OLD.state <> 'draft' THEN
    IF NOT (OLD.state = 'approved' AND NEW.state = 'superseded' AND NEW.rules = OLD.rules AND NEW.approved_by IS NOT DISTINCT FROM OLD.approved_by AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at) THEN
      RAISE EXCEPTION 'approved scoring models are immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.state = 'superseded' THEN
    RAISE EXCEPTION 'a draft cannot be superseded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scoring_versions_guard BEFORE INSERT OR UPDATE ON scoring_model_versions FOR EACH ROW EXECUTE FUNCTION scoring_versions_guard();

-- score results: append-only, only against an APPROVED model version of the same organization
GRANT SELECT, INSERT ON score_results TO app_runtime;
CREATE POLICY score_results_select ON score_results FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY score_results_insert ON score_results FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_prospects() AND computed_by = app_current_user());
CREATE FUNCTION score_results_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM scoring_model_versions v WHERE v.id = NEW.model_version_id AND v.organization_id = NEW.organization_id AND v.state IN ('approved', 'superseded')) THEN
    RAISE EXCEPTION 'scores can only be computed with an approved model version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER score_results_guard BEFORE INSERT ON score_results FOR EACH ROW EXECUTE FUNCTION score_results_guard();

-- lead threshold: explicit, org_admin only
GRANT SELECT, INSERT ON lead_settings TO app_runtime;
GRANT UPDATE (min_score, updated_by, updated_at) ON lead_settings TO app_runtime;
CREATE POLICY lead_settings_select ON lead_settings FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY lead_settings_insert ON lead_settings FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_is_org_admin() AND updated_by = app_current_user());
CREATE POLICY lead_settings_update ON lead_settings FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_is_org_admin()) WITH CHECK (organization_id = app_current_org());

-- leads
GRANT SELECT, INSERT ON leads TO app_runtime;
GRANT UPDATE (state, open_key, review_note, reviewed_by, reviewed_at) ON leads TO app_runtime;
CREATE POLICY leads_select ON leads FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY leads_insert ON leads FOR INSERT TO app_runtime WITH CHECK (
  organization_id = app_current_org() AND state = 'pending_review' AND created_by = app_current_user()
  AND (app_can_review_leads() OR (origin = 'intent' AND app_can_manage_prospects()))
);
CREATE POLICY leads_update ON leads FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_can_review_leads()) WITH CHECK (organization_id = app_current_org());

CREATE FUNCTION leads_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p prospects%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO p FROM prospects WHERE id = NEW.prospect_id AND organization_id = NEW.organization_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown prospect' USING ERRCODE = 'foreign_key_violation'; END IF;
    IF EXISTS (SELECT 1 FROM suppressions s WHERE s.organization_id = p.organization_id
               AND ((s.kind = 'domain' AND s.value_key = p.domain_key) OR (s.kind = 'name' AND s.value_key = p.name_key))) THEN
      RAISE EXCEPTION 'a suppressed prospect cannot become a lead' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.origin = 'rule' AND p.status <> 'qualified' THEN
      RAISE EXCEPTION 'rule-created leads require a qualified prospect' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF OLD.state <> 'pending_review' THEN
      RAISE EXCEPTION 'a reviewed lead cannot change' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.state = 'accepted' AND EXISTS (
      SELECT 1 FROM prospects p2 JOIN suppressions s ON s.organization_id = p2.organization_id
       AND ((s.kind = 'domain' AND s.value_key = p2.domain_key) OR (s.kind = 'name' AND s.value_key = p2.name_key))
      WHERE p2.id = NEW.prospect_id AND p2.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'a suppressed prospect cannot become a lead' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER leads_guard BEFORE INSERT OR UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION leads_guard();

-- a new suppression closes matching pending leads even when the actor cannot review leads (definer, scoped to the entry's organization)
CREATE FUNCTION suppressions_reject_leads() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.leads l SET state = 'rejected', open_key = NULL, review_note = 'suppressed', reviewed_at = now(), reviewed_by = NEW.created_by
   FROM public.prospects p
   WHERE l.organization_id = NEW.organization_id AND l.state = 'pending_review' AND p.id = l.prospect_id AND p.organization_id = l.organization_id
     AND ((NEW.kind = 'domain' AND p.domain_key = NEW.value_key) OR (NEW.kind = 'name' AND p.name_key = NEW.value_key));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION suppressions_reject_leads() FROM PUBLIC;
CREATE TRIGGER suppressions_reject_leads AFTER INSERT ON suppressions FOR EACH ROW EXECUTE FUNCTION suppressions_reject_leads();

-- intent assessments: append-only
GRANT SELECT, INSERT ON intent_assessments TO app_runtime;
CREATE POLICY intent_select ON intent_assessments FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY intent_insert ON intent_assessments FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_prospects() AND created_by = app_current_user());

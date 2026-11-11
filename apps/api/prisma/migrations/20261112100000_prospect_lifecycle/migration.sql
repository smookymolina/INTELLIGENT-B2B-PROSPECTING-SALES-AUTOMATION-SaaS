-- Prospect lifecycle (owner decision): a prospecting record lasts until (a) it becomes a lead, (b) the lead rejects us, (c) the lead does not reply
-- (sequence completed without reply) or (d) one month passes since discovery. Records are grouped in a monthly cohort (the product offers N leads/month).
--   active -> converted | rejected | no_reply | expired      (closed_at is set on the first leave from active; expired rows are anonymised, never deleted)
-- Transitions on lead / enrolment changes are done by SECURITY DEFINER triggers (least invasive: no application code touched).

ALTER TABLE prospects ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'active';
ALTER TABLE prospects ADD COLUMN cohort_month date NOT NULL DEFAULT (date_trunc('month', now() AT TIME ZONE 'UTC'))::date;
ALTER TABLE prospects ADD COLUMN expires_at timestamptz NOT NULL DEFAULT (now() + interval '1 month');
ALTER TABLE prospects ADD COLUMN closed_at timestamptz;
ALTER TABLE prospects ADD CONSTRAINT prospects_lifecycle_state CHECK (lifecycle_state IN ('active', 'converted', 'rejected', 'no_reply', 'expired'));
ALTER TABLE prospects ADD CONSTRAINT prospects_cohort_first_day CHECK (cohort_month = date_trunc('month', cohort_month)::date);

-- Backfill. Cohort = month of discovery (UTC). Existing rows with a lead take the lead outcome. Existing active rows are NOT expired retroactively:
-- they get at least 30 days from this migration so nothing already in the database is purged by surprise.
UPDATE prospects p SET cohort_month = (date_trunc('month', p.created_at AT TIME ZONE 'UTC'))::date,
  expires_at = GREATEST(p.created_at + interval '1 month', now() + interval '30 days');
UPDATE prospects p SET lifecycle_state = 'converted', closed_at = now()
  WHERE EXISTS (SELECT 1 FROM leads l WHERE l.organization_id = p.organization_id AND l.prospect_id = p.id AND l.state IN ('pending_review', 'accepted'));
UPDATE prospects p SET lifecycle_state = 'rejected', closed_at = now()
  WHERE p.lifecycle_state = 'active' AND EXISTS (SELECT 1 FROM leads l WHERE l.organization_id = p.organization_id AND l.prospect_id = p.id AND l.state = 'rejected');
CREATE INDEX prospects_lifecycle_idx ON prospects (organization_id, lifecycle_state, expires_at);
CREATE INDEX prospects_cohort_idx ON prospects (organization_id, cohort_month);

-- Monthly lead quota per organization (what the plan promises). Absent row = no quota set.
CREATE TABLE lead_quotas (
  organization_id    uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE RESTRICT,
  monthly_lead_quota integer NOT NULL CHECK (monthly_lead_quota >= 0 AND monthly_lead_quota <= 1000000),
  updated_by         uuid NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lead_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_quotas FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON lead_quotas TO app_runtime;
GRANT UPDATE (monthly_lead_quota, updated_by, updated_at) ON lead_quotas TO app_runtime;
CREATE POLICY lead_quotas_select ON lead_quotas FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY lead_quotas_insert ON lead_quotas FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_current_role() = 'org_admin' AND updated_by = app_current_user());
CREATE POLICY lead_quotas_update ON lead_quotas FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_current_role() = 'org_admin')
  WITH CHECK (organization_id = app_current_org() AND updated_by = app_current_user());

ALTER TABLE sequence_enrollments DROP CONSTRAINT sequence_enrollments_stop_reason;
ALTER TABLE sequence_enrollments ADD CONSTRAINT sequence_enrollments_stop_reason CHECK (stop_reason IS NULL OR stop_reason IN ('no_consent', 'opted_out', 'bounced', 'suppressed', 'recently_contacted', 'already_in_campaign', 'campaign_closed', 'prospect_expired'));

-- (a) lead created -> converted; lead accepted -> converted; lead rejected -> rejected. Only leaves 'active' (or converted -> rejected). Expired rows stay expired.
CREATE FUNCTION prospects_lifecycle_from_lead() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.state IN ('pending_review', 'accepted') THEN
    UPDATE public.prospects SET lifecycle_state = 'converted', closed_at = COALESCE(closed_at, now())
      WHERE id = NEW.prospect_id AND organization_id = NEW.organization_id AND lifecycle_state IN ('active', 'no_reply');
  ELSIF NEW.state = 'rejected' THEN
    UPDATE public.prospects SET lifecycle_state = 'rejected', closed_at = COALESCE(closed_at, now())
      WHERE id = NEW.prospect_id AND organization_id = NEW.organization_id AND lifecycle_state IN ('active', 'converted', 'no_reply')
        AND NOT EXISTS (SELECT 1 FROM public.leads o WHERE o.organization_id = NEW.organization_id AND o.prospect_id = NEW.prospect_id AND o.id <> NEW.id AND o.state IN ('pending_review', 'accepted'));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER prospects_lifecycle_lead AFTER INSERT OR UPDATE OF state ON leads FOR EACH ROW EXECUTE FUNCTION prospects_lifecycle_from_lead();

-- (c) a sequence that finished all its steps without a reply (state completed; a reply stops the enrolment instead) -> no_reply, unless a lead exists.
CREATE FUNCTION prospects_lifecycle_from_enrollment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.state = 'completed' AND OLD.state IS DISTINCT FROM 'completed' THEN
    UPDATE public.prospects p SET lifecycle_state = 'no_reply', closed_at = COALESCE(p.closed_at, now())
      WHERE p.organization_id = NEW.organization_id AND p.lifecycle_state = 'active'
        AND p.id = (SELECT c.prospect_id FROM public.contacts c WHERE c.id = NEW.contact_id AND c.organization_id = NEW.organization_id)
        AND NOT EXISTS (SELECT 1 FROM public.leads l WHERE l.organization_id = p.organization_id AND l.prospect_id = p.id AND l.state IN ('pending_review', 'accepted'));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER prospects_lifecycle_enrollment AFTER UPDATE OF state ON sequence_enrollments FOR EACH ROW EXECUTE FUNCTION prospects_lifecycle_from_enrollment();

-- (d) Expiry of the CURRENT tenant (org_admin context only). Touches only lifecycle_state = 'active' rows past expires_at with NO lead of any state.
-- Personal data is anonymised in place (the row is kept so cohort counts survive): prospect text fields, enrichment attributes, drafts, and the address of
-- ACTIVE contacts. Never touched: suppressions, consent_events, contacts that opted out / bounced (their address is the do-not-contact record), leads.
-- p_now is clamped to the real clock so a wrong clock cannot expire early. A re-run finds nothing left (idempotent).
CREATE FUNCTION prospects_expire_due(p_now timestamptz DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := app_current_org(); cutoff timestamptz; ids uuid[]; n integer; nc integer := 0; c record;
BEGIN
  IF app_current_role() IS DISTINCT FROM 'org_admin' OR org IS NULL THEN RAISE EXCEPTION 'org_admin required' USING ERRCODE = 'insufficient_privilege'; END IF;
  cutoff := LEAST(COALESCE(p_now, now()), now());
  SELECT COALESCE(array_agg(p.id), '{}') INTO ids FROM public.prospects p
    WHERE p.organization_id = org AND p.lifecycle_state = 'active' AND p.expires_at <= cutoff
      AND NOT EXISTS (SELECT 1 FROM public.leads l WHERE l.organization_id = org AND l.prospect_id = p.id);
  n := COALESCE(array_length(ids, 1), 0);
  IF n = 0 THEN RETURN jsonb_build_object('expired', 0, 'contactsAnonymized', 0, 'cutoff', cutoff); END IF;
  FOR c IN SELECT id FROM public.contacts WHERE organization_id = org AND prospect_id = ANY (ids) AND status = 'active' FOR UPDATE LOOP
    PERFORM public.redact_contact_drafts(c.id);
    UPDATE public.send_attempts SET state = 'cancelled' WHERE contact_id = c.id AND organization_id = org AND state = 'queued';
    UPDATE public.sequence_enrollments SET state = 'stopped', stop_reason = 'prospect_expired', next_due_at = NULL WHERE contact_id = c.id AND organization_id = org AND state = 'active';
    UPDATE public.contacts SET address = 'expired-' || c.id::text || '@expired.invalid', address_key = 'expired-' || c.id::text || '@expired.invalid',
      display_name = NULL, source = 'expired', updated_at = now() WHERE id = c.id AND organization_id = org;
    nc := nc + 1;
  END LOOP;
  DELETE FROM public.prospect_attributes WHERE organization_id = org AND prospect_id = ANY (ids);
  UPDATE public.prospects SET lifecycle_state = 'expired', closed_at = now(), name = '[expired]', name_key = 'expired:' || id::text, dedupe_key = 'expired:' || id::text || '|',
    domain_key = NULL, website = NULL, country = NULL, region = NULL, city = NULL, industry = NULL, notes = NULL, status_reason = NULL, updated_at = now()
    WHERE organization_id = org AND id = ANY (ids);
  RETURN jsonb_build_object('expired', n, 'contactsAnonymized', nc, 'cutoff', cutoff);
END $$;
REVOKE ALL ON FUNCTION prospects_expire_due(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prospects_expire_due(timestamptz) TO app_runtime;

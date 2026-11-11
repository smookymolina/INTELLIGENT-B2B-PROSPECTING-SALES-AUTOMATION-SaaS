-- Automatic retention purge (owner decision 2026-11-11). No new table.
-- Defaults (days) apply while an organization has no row of its own in retention_policies:
--   sessions 30 · invitations 30 · import_jobs 90 · jobs (finished queue rows: succeeded or dead) 30.
-- An organization changes a term with its own row (30..3650) or disables the class with retention_days = 0.
-- Never purged (no class exists for them): suppressions, consent_events, audit_events, erased_addresses, privacy_requests, contacts.

ALTER TABLE retention_policies DROP CONSTRAINT retention_class;
ALTER TABLE retention_policies ADD CONSTRAINT retention_class CHECK (data_class IN ('import_jobs', 'sessions', 'invitations', 'jobs'));
ALTER TABLE retention_policies DROP CONSTRAINT retention_min_days;
ALTER TABLE retention_policies ADD CONSTRAINT retention_min_days CHECK (retention_days = 0 OR retention_days BETWEEN 30 AND 3650);

ALTER TABLE jobs DROP CONSTRAINT jobs_type;
ALTER TABLE jobs ADD CONSTRAINT jobs_type CHECK (type IN ('sequence.run_due', 'notifications.scan_due', 'retention.purge'));

-- Mirrors RETENTION_DEFAULT_DAYS in @prospecting/contracts. NULL = unknown class.
CREATE FUNCTION retention_default_days(p_class text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_class WHEN 'sessions' THEN 30 WHEN 'invitations' THEN 30 WHEN 'import_jobs' THEN 90 WHEN 'jobs' THEN 30 END
$$;

-- Purge of ONE class of the CURRENT tenant (org_admin context). Term = the organization's policy, else the default; 0 = disabled (returns NULL).
-- p_dry = true only counts. p_now is the reference instant (tests / worker clock); it is clamped to the real clock so a wrong clock can
-- never purge more than the policy allows. Rows of other organizations are out of reach: every statement is filtered by app_current_org().
DROP FUNCTION privacy_purge(text, boolean);
CREATE FUNCTION privacy_purge(p_class text, p_dry boolean, p_now timestamptz DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := app_current_org(); days integer; src text := 'policy'; cutoff timestamptz; n integer;
BEGIN
  IF app_current_role() IS DISTINCT FROM 'org_admin' OR org IS NULL THEN RAISE EXCEPTION 'org_admin required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT retention_days INTO days FROM public.retention_policies WHERE organization_id = org AND data_class = p_class;
  IF NOT FOUND THEN days := public.retention_default_days(p_class); src := 'default'; END IF;
  IF days IS NULL THEN RAISE EXCEPTION 'unknown data class' USING ERRCODE = 'check_violation'; END IF;
  IF days = 0 THEN RETURN NULL; END IF;
  cutoff := LEAST(COALESCE(p_now, now()), now()) - make_interval(days => days);
  IF p_class = 'import_jobs' THEN
    IF p_dry THEN SELECT count(*) INTO n FROM public.import_jobs WHERE organization_id = org AND created_at < cutoff;
    ELSE WITH d AS (DELETE FROM public.import_jobs WHERE organization_id = org AND created_at < cutoff RETURNING 1) SELECT count(*) INTO n FROM d; END IF;
  ELSIF p_class = 'sessions' THEN
    IF p_dry THEN SELECT count(*) INTO n FROM public.sessions WHERE organization_id = org AND ((revoked_at IS NOT NULL AND revoked_at < cutoff) OR expires_at < cutoff);
    ELSE WITH d AS (DELETE FROM public.sessions WHERE organization_id = org AND ((revoked_at IS NOT NULL AND revoked_at < cutoff) OR expires_at < cutoff) RETURNING 1) SELECT count(*) INTO n FROM d; END IF;
  ELSIF p_class = 'invitations' THEN
    IF p_dry THEN SELECT count(*) INTO n FROM public.invitations WHERE organization_id = org AND COALESCE(accepted_at, revoked_at, expires_at) < cutoff;
    ELSE WITH d AS (DELETE FROM public.invitations WHERE organization_id = org AND COALESCE(accepted_at, revoked_at, expires_at) < cutoff RETURNING 1) SELECT count(*) INTO n FROM d; END IF;
  ELSIF p_class = 'jobs' THEN
    -- only finished rows: succeeded or dead-lettered. queued / running / failed (retry pending) are never touched.
    IF p_dry THEN SELECT count(*) INTO n FROM public.jobs WHERE organization_id = org AND state IN ('succeeded', 'dead') AND finished_at IS NOT NULL AND finished_at < cutoff;
    ELSE WITH d AS (DELETE FROM public.jobs WHERE organization_id = org AND state IN ('succeeded', 'dead') AND finished_at IS NOT NULL AND finished_at < cutoff RETURNING 1) SELECT count(*) INTO n FROM d; END IF;
  ELSE
    RAISE EXCEPTION 'unknown data class' USING ERRCODE = 'check_violation';
  END IF;
  RETURN jsonb_build_object('retentionDays', days, 'source', src, 'cutoff', cutoff, 'count', n);
END $$;

REVOKE ALL ON FUNCTION privacy_purge(text, boolean, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_purge(text, boolean, timestamptz) TO app_runtime;

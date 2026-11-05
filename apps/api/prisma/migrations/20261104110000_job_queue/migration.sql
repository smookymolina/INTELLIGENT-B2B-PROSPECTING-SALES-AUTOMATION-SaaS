-- PostgreSQL-backed job queue for the worker (sequence.run_due, notifications.scan_due).
-- Lifecycle: queued -> running -> succeeded | failed (retry scheduled with backoff) | dead (dead-letter queue: attempts exhausted or permanent error).
-- A job is claimed with FOR UPDATE SKIP LOCKED and a lease (locked_by / locked_until); an expired lease is reclaimed by another worker.

CREATE TABLE "jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "state" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "run_after" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_by" TEXT,
    "locked_until" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "last_error_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- Idempotency: one job per (organization, type, window key). Planning the same window twice creates nothing.
CREATE UNIQUE INDEX "jobs_organization_id_type_dedupe_key_key" ON "jobs"("organization_id", "type", "dedupe_key");
CREATE INDEX "jobs_state_run_after_idx" ON "jobs"("state", "run_after");
CREATE INDEX "jobs_organization_id_state_created_at_idx" ON "jobs"("organization_id", "state", "created_at" DESC, "id" DESC);

ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE jobs ADD CONSTRAINT jobs_state CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'dead'));
ALTER TABLE jobs ADD CONSTRAINT jobs_type CHECK (type IN ('sequence.run_due', 'notifications.scan_due'));
ALTER TABLE jobs ADD CONSTRAINT jobs_attempts CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 20);
ALTER TABLE jobs ADD CONSTRAINT jobs_last_error_len CHECK (last_error IS NULL OR char_length(last_error) <= 500);
-- A running job always has a lease owner.
ALTER TABLE jobs ADD CONSTRAINT jobs_running_has_lease CHECK (state <> 'running' OR (locked_by IS NOT NULL AND locked_until IS NOT NULL));

-- Row-level security: tenants see their own jobs only. The planner (acting as an org_admin of that organization) inserts; only an org_admin may
-- put a failed/dead job back in the queue. Claiming and finishing run through the SECURITY DEFINER functions below.
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON jobs TO app_runtime;
GRANT UPDATE (state, attempts, run_after, locked_by, locked_until, finished_at, updated_at) ON jobs TO app_runtime;

CREATE POLICY jobs_select ON jobs FOR SELECT TO app_runtime
  USING (organization_id = app_current_org());
CREATE POLICY jobs_insert ON jobs FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_current_role() = 'org_admin' AND state = 'queued' AND attempts = 0 AND locked_by IS NULL);
CREATE POLICY jobs_requeue ON jobs FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_current_role() = 'org_admin' AND state IN ('failed', 'dead'))
  WITH CHECK (organization_id = app_current_org() AND state = 'queued' AND attempts = 0 AND locked_by IS NULL AND locked_until IS NULL);

-- FORCE also binds the table owner, so the SECURITY DEFINER functions (which run as the owner) need an explicit policy for the owner role only.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY jobs_system ON jobs FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

-- Organizations the planner must visit, each with the org_admin that the job runs as (tenant context + audit actor).
CREATE FUNCTION jobs_list_orgs(p_after uuid, p_limit integer)
RETURNS TABLE (organization_id uuid, actor_user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT o.id, a.user_id
  FROM public.organizations o
  JOIN LATERAL (
    SELECT m.user_id FROM public.memberships m JOIN public.users u ON u.id = m.user_id AND u.status = 'active'
    WHERE m.organization_id = o.id AND m.role = 'org_admin' AND m.status = 'active'
    ORDER BY m.created_at, m.id LIMIT 1
  ) a ON true
  WHERE o.status = 'active' AND (p_after IS NULL OR o.id > p_after)
  ORDER BY o.id
  LIMIT GREATEST(1, LEAST(p_limit, 500))
$$;

-- Claims up to p_limit due jobs for one worker. SKIP LOCKED means two workers never take the same row; a running job whose lease expired is
-- reclaimed (attempt counted), unless it already used every attempt, in which case it goes to the dead-letter queue.
CREATE FUNCTION jobs_claim(p_worker text, p_lease_seconds integer, p_limit integer, p_now timestamptz)
RETURNS TABLE (id uuid, organization_id uuid, type text, payload jsonb, attempts integer, max_attempts integer, actor_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  UPDATE public.jobs j SET state = 'dead', locked_by = NULL, locked_until = NULL, last_error = 'lease expired after the last attempt',
    last_error_at = p_now, finished_at = p_now, updated_at = p_now
  WHERE j.state = 'running' AND j.locked_until < p_now AND j.attempts >= j.max_attempts;

  RETURN QUERY
  WITH c AS (
    SELECT j.id FROM public.jobs j
    WHERE (j.state IN ('queued', 'failed') AND j.run_after <= p_now) OR (j.state = 'running' AND j.locked_until < p_now)
    ORDER BY j.run_after, j.created_at, j.id
    LIMIT GREATEST(1, LEAST(p_limit, 100))
    FOR UPDATE SKIP LOCKED
  ), u AS (
    UPDATE public.jobs j SET state = 'running', attempts = j.attempts + 1, locked_by = p_worker,
      locked_until = p_now + make_interval(secs => GREATEST(p_lease_seconds, 1)), started_at = p_now, updated_at = p_now
    FROM c WHERE j.id = c.id
    RETURNING j.id, j.organization_id, j.type, j.payload, j.attempts, j.max_attempts
  )
  SELECT u.id, u.organization_id, u.type, u.payload, u.attempts, u.max_attempts,
    (SELECT m.user_id FROM public.memberships m JOIN public.users us ON us.id = m.user_id AND us.status = 'active'
      WHERE m.organization_id = u.organization_id AND m.role = 'org_admin' AND m.status = 'active' ORDER BY m.created_at, m.id LIMIT 1)
  FROM u;
END $$;

-- Fenced completion: only the worker that still holds the lease can finish the job.
CREATE FUNCTION jobs_complete(p_id uuid, p_worker text, p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE n integer;
BEGIN
  UPDATE public.jobs SET state = 'succeeded', locked_by = NULL, locked_until = NULL, finished_at = p_now, updated_at = p_now
  WHERE id = p_id AND state = 'running' AND locked_by = p_worker;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

-- Records a failed attempt. Returns the new state ('failed' = retry at p_retry_at, 'dead' = attempts exhausted or permanent error), NULL if the lease was lost.
-- p_error must already be redacted by the caller; it is truncated here as a second guard.
CREATE FUNCTION jobs_fail(p_id uuid, p_worker text, p_error text, p_retry_at timestamptz, p_permanent boolean, p_now timestamptz)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE new_state text;
BEGIN
  UPDATE public.jobs SET
    state = CASE WHEN p_permanent OR attempts >= max_attempts THEN 'dead' ELSE 'failed' END,
    run_after = CASE WHEN p_permanent OR attempts >= max_attempts THEN run_after ELSE p_retry_at END,
    finished_at = CASE WHEN p_permanent OR attempts >= max_attempts THEN p_now ELSE NULL END,
    locked_by = NULL, locked_until = NULL, last_error = left(p_error, 500), last_error_at = p_now, updated_at = p_now
  WHERE id = p_id AND state = 'running' AND locked_by = p_worker
  RETURNING state INTO new_state;
  RETURN new_state;
END $$;

-- Cross-tenant counters for the worker metrics: counts only, no ids or content.
CREATE FUNCTION jobs_stats()
RETURNS TABLE (state text, type text, n bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT j.state, j.type, count(*) FROM public.jobs j GROUP BY j.state, j.type $$;

REVOKE ALL ON FUNCTION jobs_list_orgs(uuid, integer), jobs_claim(text, integer, integer, timestamptz), jobs_complete(uuid, text, timestamptz),
  jobs_fail(uuid, text, text, timestamptz, boolean, timestamptz), jobs_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jobs_list_orgs(uuid, integer), jobs_claim(text, integer, integer, timestamptz), jobs_complete(uuid, text, timestamptz),
  jobs_fail(uuid, text, text, timestamptz, boolean, timestamptz), jobs_stats() TO app_runtime;

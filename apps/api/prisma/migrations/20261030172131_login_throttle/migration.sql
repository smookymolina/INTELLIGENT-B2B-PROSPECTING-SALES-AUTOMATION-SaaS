-- CreateTable
CREATE TABLE "login_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ip_hash" TEXT NOT NULL,
    "account_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "login_attempts_ip_hash_created_at_idx" ON "login_attempts"("ip_hash", "created_at");

-- CreateIndex
CREATE INDEX "login_attempts_account_hash_created_at_idx" ON "login_attempts"("account_hash", "created_at");

-- CreateIndex
CREATE INDEX "login_attempts_created_at_idx" ON "login_attempts"("created_at");

-- Login throttle (P2-12). RLS enabled with NO policy and NO grant: app_runtime can only use the functions below.
-- Each row is an attempt that has not (yet) been cleared by a success. Attempts are inserted at check time, atomically
-- (advisory locks), so concurrent bursts cannot overshoot. Blocked requests are NOT recorded: lockout decays, hammering cannot extend it.
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION auth_login_begin(p_ip_hash text, p_account_hash text, p_window_seconds int, p_ip_max int, p_account_max int)
RETURNS TABLE (allowed boolean, retry_after_seconds int, attempt_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := now();
  v_since timestamptz := v_now - make_interval(secs => p_window_seconds);
  v_ip_n int;
  v_acct_n int;
  v_retry int := 0;
  v_expiry timestamptz;
  v_id uuid;
BEGIN
  -- Fixed lock order (account, then ip) avoids deadlocks.
  PERFORM pg_advisory_xact_lock(hashtextextended('acct:' || p_account_hash, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ip:' || p_ip_hash, 0));

  DELETE FROM login_attempts WHERE created_at < v_now - interval '24 hours'; -- retention

  SELECT count(*) INTO v_acct_n FROM login_attempts WHERE account_hash = p_account_hash AND created_at >= v_since;
  SELECT count(*) INTO v_ip_n FROM login_attempts WHERE ip_hash = p_ip_hash AND created_at >= v_since;

  IF v_acct_n >= p_account_max THEN
    SELECT created_at + make_interval(secs => p_window_seconds) INTO v_expiry FROM login_attempts
      WHERE account_hash = p_account_hash AND created_at >= v_since ORDER BY created_at OFFSET (v_acct_n - p_account_max) LIMIT 1;
    v_retry := greatest(v_retry, ceil(extract(epoch FROM v_expiry - v_now))::int);
  END IF;
  IF v_ip_n >= p_ip_max THEN
    SELECT created_at + make_interval(secs => p_window_seconds) INTO v_expiry FROM login_attempts
      WHERE ip_hash = p_ip_hash AND created_at >= v_since ORDER BY created_at OFFSET (v_ip_n - p_ip_max) LIMIT 1;
    v_retry := greatest(v_retry, ceil(extract(epoch FROM v_expiry - v_now))::int);
  END IF;

  IF v_retry > 0 THEN
    RETURN QUERY SELECT false, v_retry, NULL::uuid;
    RETURN;
  END IF;

  INSERT INTO login_attempts (ip_hash, account_hash) VALUES (p_ip_hash, p_account_hash) RETURNING id INTO v_id;
  RETURN QUERY SELECT true, 0, v_id;
END $$;

-- Success clears the account's failures and this attempt (so it no longer counts against the IP); other failures from the IP remain.
CREATE FUNCTION auth_login_succeeded(p_attempt_id uuid, p_account_hash text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ DELETE FROM public.login_attempts WHERE id = p_attempt_id OR account_hash = p_account_hash $$;

REVOKE ALL ON FUNCTION auth_login_begin(text, text, int, int, int), auth_login_succeeded(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_login_begin(text, text, int, int, int), auth_login_succeeded(uuid, text) TO app_runtime;

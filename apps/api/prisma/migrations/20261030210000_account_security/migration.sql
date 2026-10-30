-- Account security: password change that atomically revokes the user's other sessions in EVERY organization.
-- The runtime role cannot read or write users.password_hash (column privileges), so this is a minimal SECURITY DEFINER function.
-- It trusts p_user_id only because the application passes the authenticated session's user (same contract as the other auth_* functions).
CREATE FUNCTION auth_change_password(p_user_id uuid, p_password_hash text, p_keep_session uuid)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  WITH changed AS (
    UPDATE public.users SET password_hash = p_password_hash, updated_at = now() WHERE id = p_user_id AND status = 'active' RETURNING id
  ), revoked AS (
    UPDATE public.sessions s SET revoked_at = now()
    WHERE s.user_id IN (SELECT id FROM changed) AND s.revoked_at IS NULL AND s.id <> p_keep_session
    RETURNING s.id
  )
  SELECT (SELECT count(*) FROM revoked)::integer
$$;
REVOKE ALL ON FUNCTION auth_change_password(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_change_password(uuid, text, uuid) TO app_runtime;

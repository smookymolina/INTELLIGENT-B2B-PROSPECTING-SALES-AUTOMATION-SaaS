-- Phase 2: tenant isolation (RLS), least-privilege runtime role, append-only audit, narrow auth functions.
-- Model: the app connects as the migration owner and runs every statement inside a transaction that does
-- `SET LOCAL ROLE app_runtime` + sets app.organization_id/app.user_id/app.role from the VERIFIED session.
-- app_runtime is NOLOGIN, non-owner, NOBYPASSRLS, so RLS always applies to it. Missing context => no rows (fail closed).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
END $$;

-- Lets a non-superuser migration/login role `SET ROLE app_runtime` (no-op for superusers).
DO $$ BEGIN EXECUTE format('GRANT app_runtime TO %I', current_user); END $$;

GRANT USAGE ON SCHEMA public TO app_runtime;

-- Context accessors: unset/empty => NULL => every policy comparison is NULL => denied.
CREATE FUNCTION app_current_org() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid $$;
CREATE FUNCTION app_current_user() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION app_current_role() RETURNS text LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.role', true), '') $$;
GRANT EXECUTE ON FUNCTION app_current_org(), app_current_user(), app_current_role() TO app_runtime;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events  ENABLE ROW LEVEL SECURITY;

-- organizations: only the current tenant; renaming requires org_admin; never deletable by runtime.
GRANT SELECT, INSERT ON organizations TO app_runtime;
GRANT UPDATE (name, updated_at) ON organizations TO app_runtime;
CREATE POLICY organizations_select ON organizations FOR SELECT TO app_runtime USING (id = app_current_org());
CREATE POLICY organizations_insert ON organizations FOR INSERT TO app_runtime WITH CHECK (id = app_current_org());
CREATE POLICY organizations_update ON organizations FOR UPDATE TO app_runtime
  USING (id = app_current_org() AND app_current_role() = 'org_admin')
  WITH CHECK (id = app_current_org());

-- users: global identity. Runtime can never read password_hash (column privileges); sees only self or members of the current tenant.
GRANT SELECT (id, email, display_name, status, created_at, updated_at) ON users TO app_runtime;
GRANT INSERT ON users TO app_runtime;
GRANT UPDATE (display_name, updated_at) ON users TO app_runtime;
CREATE POLICY users_select ON users FOR SELECT TO app_runtime USING (
  id = app_current_user()
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.organization_id = app_current_org())
);
CREATE POLICY users_insert ON users FOR INSERT TO app_runtime WITH CHECK (id = app_current_user());
CREATE POLICY users_update ON users FOR UPDATE TO app_runtime
  USING (id = app_current_user()) WITH CHECK (id = app_current_user());

-- memberships: tenant-scoped; writes require org_admin (defense in depth next to API RBAC). organization_id/user_id immutable (column grants).
GRANT SELECT, INSERT, DELETE ON memberships TO app_runtime;
GRANT UPDATE (role, status, updated_at) ON memberships TO app_runtime;
CREATE POLICY memberships_select ON memberships FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY memberships_insert ON memberships FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_current_role() = 'org_admin');
CREATE POLICY memberships_update ON memberships FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_current_role() = 'org_admin')
  WITH CHECK (organization_id = app_current_org());
CREATE POLICY memberships_delete ON memberships FOR DELETE TO app_runtime
  USING (organization_id = app_current_org() AND app_current_role() = 'org_admin');

-- sessions: a session row is visible/creatable only inside its own tenant and for the authenticated user.
GRANT SELECT, INSERT ON sessions TO app_runtime;
GRANT UPDATE (revoked_at) ON sessions TO app_runtime;
CREATE POLICY sessions_select ON sessions FOR SELECT TO app_runtime
  USING (organization_id = app_current_org() AND user_id = app_current_user());
CREATE POLICY sessions_insert ON sessions FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND user_id = app_current_user());
CREATE POLICY sessions_update ON sessions FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND user_id = app_current_user())
  WITH CHECK (organization_id = app_current_org() AND user_id = app_current_user());

-- audit_events: insert + select within tenant only. No UPDATE/DELETE grant or policy, and a trigger blocks them for every role.
GRANT SELECT, INSERT ON audit_events TO app_runtime;
CREATE POLICY audit_events_select ON audit_events FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY audit_events_insert ON audit_events FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org());

CREATE FUNCTION audit_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_events_no_mutation BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

-- Pre-tenant authentication helpers. SECURITY DEFINER (owner bypasses RLS because FORCE is not set); each returns the minimum.
CREATE FUNCTION auth_lookup_user(p_email text)
RETURNS TABLE (id uuid, password_hash text, status record_status)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT u.id, u.password_hash, u.status FROM public.users u WHERE u.email = lower(p_email) $$;

CREATE FUNCTION auth_list_memberships(p_user_id uuid)
RETURNS TABLE (organization_id uuid, slug text, role membership_role)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT m.organization_id, o.slug, m.role
  FROM public.memberships m JOIN public.organizations o ON o.id = m.organization_id
  WHERE m.user_id = p_user_id AND m.status = 'active' AND o.status = 'active'
  ORDER BY m.created_at, m.id
$$;

CREATE FUNCTION auth_resolve_session(p_token_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, organization_id uuid, role membership_role)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.user_id, s.organization_id, m.role
  FROM public.sessions s
  JOIN public.users u ON u.id = s.user_id AND u.status = 'active'
  JOIN public.organizations o ON o.id = s.organization_id AND o.status = 'active'
  JOIN public.memberships m ON m.user_id = s.user_id AND m.organization_id = s.organization_id AND m.status = 'active'
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now()
$$;

REVOKE ALL ON FUNCTION auth_lookup_user(text), auth_list_memberships(uuid), auth_resolve_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_user(text), auth_list_memberships(uuid), auth_resolve_session(text) TO app_runtime;

-- Canonical identifiers: emails/slugs are stored lowercase so lookups are deterministic.
ALTER TABLE users ADD CONSTRAINT users_email_lowercase CHECK (email = lower(email));
ALTER TABLE organizations ADD CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

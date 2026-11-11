-- Superadministrador de plataforma (saas_admin), decision del duenio: puede VER todo de todas las organizaciones.
-- Solo lectura, solo mediante funciones SECURITY DEFINER explicitas (no hay BYPASSRLS ni politica general), y cada lectura
-- deja una fila `platform_admin.read` en el audit_events de la organizacion consultada (visible para ese tenant).
-- La tabla platform_admins NO se puede escribir desde la API: app_runtime no tiene ningun privilegio sobre ella.
-- Se asigna solo por SQL de operador:  INSERT INTO platform_admins (user_id) VALUES ('<uuid>');

CREATE TABLE platform_admins (
  user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now()
);
-- RLS activa y SIN politicas: app_runtime no ve nada. No se fuerza (FORCE) porque las funciones DEFINER (duenio) la leen;
-- ademas app_runtime no recibe GRANT alguno, asi que ni siquiera llega a la politica.
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON platform_admins FROM PUBLIC;

-- opportunities y quotes tienen FORCE RLS: el duenio (que ejecuta las funciones DEFINER) necesita una politica de SOLO LECTURA propia.
-- Solo aplica al rol duenio; la aplicacion nunca se conecta como duenio (app_login -> app_runtime).
DO $$ BEGIN
  EXECUTE format('CREATE POLICY opportunities_platform_read ON opportunities FOR SELECT TO %I USING (true)', current_user);
  EXECUTE format('CREATE POLICY quotes_platform_read ON quotes FOR SELECT TO %I USING (true)', current_user);
END $$;

CREATE FUNCTION platform_admin_is() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT EXISTS (SELECT 1 FROM public.platform_admins pa JOIN public.users u ON u.id = pa.user_id
                     WHERE pa.user_id = public.app_current_user() AND u.status = 'active') $$;

CREATE FUNCTION platform_admin_require() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ BEGIN
  IF NOT public.platform_admin_is() THEN RAISE EXCEPTION 'platform_admin_required' USING ERRCODE = '42501'; END IF;
  RETURN public.app_current_user();
END $$;

-- Listado de organizaciones con conteos. Audita una fila por organizacion devuelta.
CREATE FUNCTION platform_admin_organizations(p_limit int, p_offset int, p_request_id text)
RETURNS TABLE (id uuid, name text, slug text, status text, created_at timestamptz,
               users bigint, prospects bigint, leads bigint, opportunities bigint, quotes bigint, campaigns bigint, total bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor uuid := public.platform_admin_require();
        lim int := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
        off int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS pa_orgs_tmp (id uuid) ON COMMIT DROP;
  DELETE FROM pa_orgs_tmp;
  INSERT INTO pa_orgs_tmp SELECT o.id FROM public.organizations o ORDER BY o.created_at, o.id LIMIT lim OFFSET off;
  INSERT INTO public.audit_events (id, organization_id, actor_user_id, action, resource_type, resource_id, metadata, request_id)
    SELECT gen_random_uuid(), t.id, actor, 'platform_admin.read', 'organization', t.id::text, jsonb_build_object('resource', 'organizations', 'limit', lim, 'offset', off), p_request_id
    FROM pa_orgs_tmp t;
  RETURN QUERY
  SELECT o.id, o.name, o.slug, o.status::text, o.created_at,
         (SELECT count(*) FROM public.memberships x WHERE x.organization_id = o.id),
         (SELECT count(*) FROM public.prospects x WHERE x.organization_id = o.id),
         (SELECT count(*) FROM public.leads x WHERE x.organization_id = o.id),
         (SELECT count(*) FROM public.opportunities x WHERE x.organization_id = o.id),
         (SELECT count(*) FROM public.quotes x WHERE x.organization_id = o.id),
         (SELECT count(*) FROM public.campaigns x WHERE x.organization_id = o.id),
         (SELECT count(*) FROM public.organizations)
  FROM public.organizations o JOIN pa_orgs_tmp t ON t.id = o.id
  ORDER BY o.created_at, o.id;
END $$;

-- Listado acotado por organizacion y recurso. Columnas en lista blanca: nunca hashes, tokens ni credenciales SMTP.
CREATE FUNCTION platform_admin_resource(p_org uuid, p_resource text, p_limit int, p_offset int, p_request_id text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE actor uuid := public.platform_admin_require();
        lim int := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
        off int := GREATEST(COALESCE(p_offset, 0), 0);
        total bigint; items jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE organizations.id = p_org) THEN RAISE EXCEPTION 'organization_not_found' USING ERRCODE = 'P0002'; END IF;
  IF p_resource = 'users' THEN
    SELECT count(*) INTO total FROM public.memberships WHERE organization_id = p_org;
    SELECT COALESCE(jsonb_agg(r), '[]') INTO items FROM (
      SELECT jsonb_build_object('userId', u.id, 'email', u.email, 'displayName', u.display_name, 'role', m.role, 'status', m.status, 'createdAt', m.created_at) AS r
      FROM public.memberships m JOIN public.users u ON u.id = m.user_id WHERE m.organization_id = p_org ORDER BY m.created_at, m.id LIMIT lim OFFSET off) s;
  ELSIF p_resource = 'prospects' THEN
    SELECT count(*) INTO total FROM public.prospects WHERE organization_id = p_org;
    SELECT COALESCE(jsonb_agg(r), '[]') INTO items FROM (
      SELECT jsonb_build_object('id', x.id, 'name', x.name, 'domain', x.domain_key, 'website', x.website, 'country', x.country, 'city', x.city, 'industry', x.industry, 'status', x.status, 'createdAt', x.created_at) AS r
      FROM public.prospects x WHERE x.organization_id = p_org ORDER BY x.created_at, x.id LIMIT lim OFFSET off) s;
  ELSIF p_resource = 'leads' THEN
    SELECT count(*) INTO total FROM public.leads WHERE organization_id = p_org;
    SELECT COALESCE(jsonb_agg(r), '[]') INTO items FROM (
      SELECT jsonb_build_object('id', x.id, 'prospectId', x.prospect_id, 'origin', x.origin, 'state', x.state, 'minScore', x.min_score, 'createdAt', x.created_at) AS r
      FROM public.leads x WHERE x.organization_id = p_org ORDER BY x.created_at, x.id LIMIT lim OFFSET off) s;
  ELSIF p_resource = 'opportunities' THEN
    SELECT count(*) INTO total FROM public.opportunities WHERE organization_id = p_org;
    SELECT COALESCE(jsonb_agg(r), '[]') INTO items FROM (
      SELECT jsonb_build_object('id', x.id, 'title', x.title, 'stage', x.stage, 'prospectId', x.prospect_id, 'expectedValue', x.expected_value, 'currency', x.currency, 'closedAt', x.closed_at, 'createdAt', x.created_at) AS r
      FROM public.opportunities x WHERE x.organization_id = p_org ORDER BY x.created_at, x.id LIMIT lim OFFSET off) s;
  ELSIF p_resource = 'quotes' THEN
    SELECT count(*) INTO total FROM public.quotes WHERE organization_id = p_org;
    SELECT COALESCE(jsonb_agg(r), '[]') INTO items FROM (
      SELECT jsonb_build_object('id', x.id, 'number', x.number, 'status', x.status, 'opportunityId', x.opportunity_id, 'currency', x.currency, 'total', x.total, 'createdAt', x.created_at) AS r
      FROM public.quotes x WHERE x.organization_id = p_org ORDER BY x.created_at, x.id LIMIT lim OFFSET off) s;
  ELSIF p_resource = 'campaigns' THEN
    SELECT count(*) INTO total FROM public.campaigns WHERE organization_id = p_org;
    SELECT COALESCE(jsonb_agg(r), '[]') INTO items FROM (
      SELECT jsonb_build_object('id', x.id, 'name', x.name, 'subject', x.subject, 'state', x.state, 'launchedAt', x.launched_at, 'createdAt', x.created_at) AS r
      FROM public.campaigns x WHERE x.organization_id = p_org ORDER BY x.created_at, x.id LIMIT lim OFFSET off) s;
  ELSE
    RAISE EXCEPTION 'unknown_resource' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.audit_events (id, organization_id, actor_user_id, action, resource_type, resource_id, metadata, request_id)
    VALUES (gen_random_uuid(), p_org, actor, 'platform_admin.read', 'organization', p_org::text, jsonb_build_object('resource', p_resource, 'limit', lim, 'offset', off), p_request_id);
  RETURN jsonb_build_object('total', total, 'limit', lim, 'offset', off, 'items', items);
END $$;

REVOKE ALL ON FUNCTION platform_admin_is(), platform_admin_require(), platform_admin_organizations(int, int, text), platform_admin_resource(uuid, text, int, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_admin_is(), platform_admin_organizations(int, int, text), platform_admin_resource(uuid, text, int, int, text) TO app_runtime;

-- Organizations of the authenticated user (with display names) for the organization switcher.
-- SECURITY DEFINER because the caller has no tenant context yet; it only returns the user's OWN active memberships.
CREATE FUNCTION auth_list_my_organizations(p_user_id uuid)
RETURNS TABLE (organization_id uuid, name text, slug text, role membership_role)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT m.organization_id, o.name, o.slug, m.role
  FROM public.memberships m JOIN public.organizations o ON o.id = m.organization_id
  WHERE m.user_id = p_user_id AND m.status = 'active' AND o.status = 'active'
  ORDER BY o.name, m.organization_id
$$;
REVOKE ALL ON FUNCTION auth_list_my_organizations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_list_my_organizations(uuid) TO app_runtime;

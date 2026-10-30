-- Invitations (P2-11): tenant-scoped offers; acceptance is a narrow SECURITY DEFINER function.
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations ADD CONSTRAINT invitations_email_lowercase CHECK (email = lower(email));

-- token_hash is never selectable by the runtime role (it can only be written).
GRANT SELECT (id, organization_id, email, role, invited_by, expires_at, accepted_at, accepted_by, revoked_at, created_at) ON invitations TO app_runtime;
GRANT INSERT ON invitations TO app_runtime;
GRANT UPDATE (revoked_at) ON invitations TO app_runtime;

CREATE POLICY invitations_select ON invitations FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY invitations_insert ON invitations FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_current_role() = 'org_admin' AND invited_by = app_current_user());
CREATE POLICY invitations_update ON invitations FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_current_role() = 'org_admin')
  WITH CHECK (organization_id = app_current_org());

-- Accept: single atomic statement chain. Returns zero rows for EVERY failure (unknown token, expired, used, revoked, inactive org/user,
-- email mismatch) so callers cannot tell them apart. The email check is part of the consuming UPDATE, so a wrong user cannot burn a token.
-- An existing membership is never modified (no silent role change); acceptance is then a no-op that reports membership_created = false.
CREATE FUNCTION invitation_accept(p_token_hash text, p_user_id uuid, p_request_id text)
RETURNS TABLE (organization_id uuid, organization_name text, slug text, role membership_role, membership_created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_email text;
  v_inv public.invitations%ROWTYPE;
  v_membership_id uuid;
  v_role public.membership_role;
  v_created boolean := true;
BEGIN
  SELECT u.email INTO v_email FROM public.users u WHERE u.id = p_user_id AND u.status = 'active';
  IF v_email IS NULL THEN RETURN; END IF;

  UPDATE public.invitations i SET accepted_at = now(), accepted_by = p_user_id
   WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.revoked_at IS NULL
     AND i.expires_at > now() AND i.email = v_email
     AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = i.organization_id AND o.status = 'active')
  RETURNING * INTO v_inv;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO public.memberships (id, organization_id, user_id, role, updated_at)
    VALUES (gen_random_uuid(), v_inv.organization_id, p_user_id, v_inv.role, now())
    ON CONFLICT (organization_id, user_id) DO NOTHING
    RETURNING id INTO v_membership_id;
  IF v_membership_id IS NULL THEN
    v_created := false;
    SELECT m.id, m.role INTO v_membership_id, v_role FROM public.memberships m WHERE m.organization_id = v_inv.organization_id AND m.user_id = p_user_id;
  ELSE
    v_role := v_inv.role;
    INSERT INTO public.audit_events (id, organization_id, actor_user_id, action, resource_type, resource_id, metadata, request_id)
      VALUES (gen_random_uuid(), v_inv.organization_id, p_user_id, 'membership.created', 'membership', v_membership_id::text,
              jsonb_build_object('role', v_role, 'via', 'invitation'), p_request_id);
  END IF;

  INSERT INTO public.audit_events (id, organization_id, actor_user_id, action, resource_type, resource_id, metadata, request_id)
    VALUES (gen_random_uuid(), v_inv.organization_id, p_user_id, 'invitation.accepted', 'invitation', v_inv.id::text,
            jsonb_build_object('role', v_inv.role, 'membershipCreated', v_created), p_request_id);

  RETURN QUERY SELECT o.id, o.name, o.slug, v_role, v_created FROM public.organizations o WHERE o.id = v_inv.organization_id;
END $$;

REVOKE ALL ON FUNCTION invitation_accept(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_accept(text, uuid, text) TO app_runtime;

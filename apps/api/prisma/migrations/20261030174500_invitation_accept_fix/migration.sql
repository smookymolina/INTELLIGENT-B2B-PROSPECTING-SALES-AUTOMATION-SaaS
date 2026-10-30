-- Fix: OUT column names (organization_id, role, slug) clashed with table columns inside plpgsql. Resolve conflicts in favour of columns.
CREATE OR REPLACE FUNCTION invitation_accept(p_token_hash text, p_user_id uuid, p_request_id text)
RETURNS TABLE (organization_id uuid, organization_name text, slug text, role membership_role, membership_created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
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


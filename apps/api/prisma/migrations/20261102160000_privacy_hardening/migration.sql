-- P12-04 hardening (security audit Q1).
--
-- 1) Erased-address fingerprints become HMAC-SHA256(pepper, org || ':' || normalized address). The pepper is derived by the
--    APPLICATION from HMAC_SECRET and is never stored here: the hash is computed in the app and passed as a parameter to the
--    SECURITY DEFINER functions. The old fingerprints were SHA-256 salted with the (public) organization id, so they were
--    guessable and invertible by brute force. Existing rows are DEVELOPMENT DATA ONLY and cannot be re-keyed (the plain
--    address is gone by design), so they are discarded here.
-- 2) Normalization (lowercase, strip +tag from the local part of emails) happens in the app before hashing, on erase and on lookup.
-- 3) The fingerprints are no longer readable by any application role (only the SECURITY DEFINER functions touch them).
-- 4) A restriction remembers the contact status it started from, and lifting it restores that status.

DELETE FROM erased_addresses;
DROP POLICY erased_select ON erased_addresses;
REVOKE ALL ON erased_addresses FROM app_runtime;

ALTER TABLE contacts ADD COLUMN restricted_from TEXT;
ALTER TABLE contacts ADD CONSTRAINT contact_restricted_from CHECK (restricted_from IS NULL OR (status = 'restricted' AND restricted_from IN ('active', 'opted_out', 'bounced')));

-- Registration check (called by the app before it inserts a contact). The hash comes from the app; this function leaves a
-- transaction-local mark so that contacts_guard can insist the check ran for exactly this address.
CREATE FUNCTION privacy_assert_address_free(p_address_key text, p_hash text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF app_current_org() IS NULL THEN RAISE EXCEPTION 'tenant context required' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid address fingerprint' USING ERRCODE = 'check_violation'; END IF;
  IF EXISTS (SELECT 1 FROM public.erased_addresses e WHERE e.organization_id = app_current_org() AND e.address_hash = p_hash) THEN
    RAISE EXCEPTION 'this address was erased on a data-subject request and cannot be contacted again' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.address_checked', p_address_key, true);
END $$;
REVOKE ALL ON FUNCTION privacy_assert_address_free(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_assert_address_free(text, text) TO app_runtime;

CREATE OR REPLACE FUNCTION contacts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN RAISE EXCEPTION 'a contact starts active' USING ERRCODE = 'check_violation'; END IF;
    IF current_user = 'app_runtime' AND COALESCE(current_setting('app.address_checked', true), '') <> NEW.address_key THEN
      RAISE EXCEPTION 'the erased-address check must run before registering a contact' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'erased' AND (NEW.status, NEW.prospect_id, NEW.address, NEW.address_key, NEW.display_name, NEW.source) IS DISTINCT FROM (OLD.status, OLD.prospect_id, OLD.address, OLD.address_key, OLD.display_name, OLD.source) THEN
    RAISE EXCEPTION 'an erased contact cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (NEW.status IN ('restricted', 'erased') OR OLD.status = 'restricted') AND current_user = 'app_runtime' THEN
    RAISE EXCEPTION 'restriction and erasure go through the privacy workflow' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'opted_out' AND NEW.status NOT IN ('opted_out', 'restricted', 'erased') AND NOT EXISTS (
       SELECT 1 FROM consent_events g
       WHERE g.contact_id = NEW.id AND g.organization_id = NEW.organization_id AND g.event = 'granted'
         AND g.created_at >= COALESCE((SELECT max(w.created_at) FROM consent_events w WHERE w.contact_id = NEW.id AND w.organization_id = NEW.organization_id AND w.event = 'withdrawn'), '-infinity')
         AND (SELECT e.event FROM consent_events e WHERE e.contact_id = NEW.id AND e.organization_id = NEW.organization_id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) = 'granted') THEN
    RAISE EXCEPTION 'an opted-out contact only returns with a new recorded consent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP FUNCTION privacy_erase_contact(uuid);
CREATE FUNCTION privacy_erase_contact(p_contact uuid, p_hash text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c public.contacts%ROWTYPE;
BEGIN
  IF app_current_role() IS DISTINCT FROM 'org_admin' OR app_current_org() IS NULL THEN RAISE EXCEPTION 'org_admin required' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid address fingerprint' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO c FROM public.contacts WHERE id = p_contact AND organization_id = app_current_org() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contact not found' USING ERRCODE = 'no_data_found'; END IF;
  IF c.status = 'erased' THEN RAISE EXCEPTION 'the contact is already erased' USING ERRCODE = 'check_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.privacy_requests r WHERE r.organization_id = c.organization_id AND r.contact_id = p_contact AND r.kind = 'erase' AND r.status = 'open') THEN
    RAISE EXCEPTION 'no open erase request for this contact' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.erased_addresses (organization_id, address_hash, contact_id, erased_by)
  VALUES (c.organization_id, p_hash, c.id, app_current_user()) ON CONFLICT DO NOTHING;
  UPDATE public.send_attempts SET state = 'cancelled' WHERE contact_id = c.id AND organization_id = c.organization_id AND state = 'queued';
  UPDATE public.consent_events SET evidence = 'erased on a data-subject request' WHERE contact_id = c.id AND organization_id = c.organization_id;
  PERFORM public.redact_contact_drafts(c.id);
  UPDATE public.contacts SET address = 'erased-' || c.id::text || '@erased.invalid', address_key = 'erased-' || c.id::text || '@erased.invalid',
    display_name = NULL, source = 'erased', status = 'erased', restricted_from = NULL, updated_at = now() WHERE id = c.id AND organization_id = c.organization_id;
END $$;
REVOKE ALL ON FUNCTION privacy_erase_contact(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_erase_contact(uuid, text) TO app_runtime;

DROP FUNCTION privacy_address_hash(uuid, text);

CREATE OR REPLACE FUNCTION privacy_restrict_contact(p_contact uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s text;
BEGIN
  IF app_current_role() IS DISTINCT FROM 'org_admin' OR app_current_org() IS NULL THEN RAISE EXCEPTION 'org_admin required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT status INTO s FROM public.contacts WHERE id = p_contact AND organization_id = app_current_org() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contact not found' USING ERRCODE = 'no_data_found'; END IF;
  IF s = 'erased' THEN RAISE EXCEPTION 'the contact is already erased' USING ERRCODE = 'check_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.privacy_requests r WHERE r.organization_id = app_current_org() AND r.contact_id = p_contact AND r.kind = 'restrict' AND r.status = 'open') THEN
    RAISE EXCEPTION 'no open restrict request for this contact' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.contacts SET restricted_from = CASE WHEN s = 'restricted' THEN restricted_from ELSE s END, status = 'restricted', updated_at = now()
   WHERE id = p_contact AND organization_id = app_current_org();
  UPDATE public.send_attempts SET state = 'cancelled' WHERE contact_id = p_contact AND organization_id = app_current_org() AND state = 'queued';
END $$;

-- Lifting restores the status the restriction started from; it never makes a contact more eligible than it was.
CREATE OR REPLACE FUNCTION privacy_lift_restriction(p_contact uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s text; prior text; latest text; target text;
BEGIN
  IF app_current_role() IS DISTINCT FROM 'org_admin' OR app_current_org() IS NULL THEN RAISE EXCEPTION 'org_admin required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT status, restricted_from INTO s, prior FROM public.contacts WHERE id = p_contact AND organization_id = app_current_org() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contact not found' USING ERRCODE = 'no_data_found'; END IF;
  IF s <> 'restricted' THEN RAISE EXCEPTION 'the contact is not restricted' USING ERRCODE = 'check_violation'; END IF;
  SELECT event INTO latest FROM public.consent_events WHERE contact_id = p_contact AND organization_id = app_current_org() ORDER BY occurred_at DESC, created_at DESC LIMIT 1;
  target := CASE
    WHEN latest = 'withdrawn' THEN 'opted_out'
    WHEN prior = 'opted_out' AND latest IS DISTINCT FROM 'granted' THEN 'opted_out'
    WHEN prior = 'bounced' THEN 'bounced'
    ELSE 'active' END;
  UPDATE public.contacts SET status = target, restricted_from = NULL, updated_at = now() WHERE id = p_contact AND organization_id = app_current_org();
  RETURN target;
END $$;

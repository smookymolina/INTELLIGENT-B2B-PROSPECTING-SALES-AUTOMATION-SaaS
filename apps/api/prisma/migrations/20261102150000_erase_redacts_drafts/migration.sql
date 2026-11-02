-- Erasing a contact (privacy_erase_contact) must also remove personal data from its message drafts, whose content is otherwise immutable.
-- The only way past the immutability trigger is redact_contact_drafts(), which leaves a transaction-scoped mark in a table the app role cannot touch.

-- An erased WhatsApp contact keeps the anonymised placeholder address (email-shaped), so the address rule admits it.
ALTER TABLE contacts DROP CONSTRAINT contact_address;
ALTER TABLE contacts ADD CONSTRAINT contact_address CHECK (
  ((channel = 'email' OR status = 'erased') AND address ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    OR channel = 'whatsapp' AND address ~ '^\+[1-9][0-9]{7,14}$')
  AND char_length(address) <= 254 AND address_key = lower(address));

CREATE TABLE draft_redaction_marks (xid BIGINT PRIMARY KEY);
ALTER TABLE draft_redaction_marks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON draft_redaction_marks FROM PUBLIC;

CREATE FUNCTION redact_contact_drafts(p_contact uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  INSERT INTO public.draft_redaction_marks (xid) VALUES (txid_current()) ON CONFLICT DO NOTHING;
  UPDATE public.message_drafts SET
    subject = CASE WHEN channel = 'email' THEN '[redacted]' ELSE NULL END,
    body = '[redacted]', evidence_refs = '{}',
    decision_note = CASE WHEN decision_note IS NULL THEN NULL ELSE '[redacted]' END
  WHERE contact_id = p_contact;
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM public.draft_redaction_marks WHERE xid = txid_current();
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION redact_contact_drafts(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION message_drafts_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'message drafts are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending_review' THEN RAISE EXCEPTION 'a draft starts pending review' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.draft_redaction_marks WHERE xid = txid_current()) THEN
    IF (NEW.organization_id, NEW.contact_id, NEW.channel, NEW.author_kind, NEW.created_by, NEW.created_at, NEW.status, NEW.decided_by, NEW.decided_at)
       IS DISTINCT FROM (OLD.organization_id, OLD.contact_id, OLD.channel, OLD.author_kind, OLD.created_by, OLD.created_at, OLD.status, OLD.decided_by, OLD.decided_at) THEN
      RAISE EXCEPTION 'a redaction only replaces personal content' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.organization_id, NEW.contact_id, NEW.channel, NEW.subject, NEW.body, NEW.evidence_refs, NEW.author_kind, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.organization_id, OLD.contact_id, OLD.channel, OLD.subject, OLD.body, OLD.evidence_refs, OLD.author_kind, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'draft content is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (OLD.status = 'pending_review' AND NEW.status IN ('approved', 'rejected')) THEN
      RAISE EXCEPTION 'invalid draft transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NOT app_can_approve_campaigns() THEN RAISE EXCEPTION 'this role cannot decide drafts' USING ERRCODE = 'insufficient_privilege'; END IF;
    NEW.decided_by := app_current_user();
    NEW.decided_at := now();
  ELSIF (NEW.decided_by, NEW.decided_at, NEW.decision_note) IS DISTINCT FROM (OLD.decided_by, OLD.decided_at, OLD.decision_note) THEN
    RAISE EXCEPTION 'decision fields are set by the database' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- B2's erase function, unchanged except for the redaction call (same transaction).
CREATE OR REPLACE FUNCTION privacy_erase_contact(p_contact uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c public.contacts%ROWTYPE;
BEGIN
  IF app_current_role() IS DISTINCT FROM 'org_admin' OR app_current_org() IS NULL THEN RAISE EXCEPTION 'org_admin required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO c FROM public.contacts WHERE id = p_contact AND organization_id = app_current_org() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contact not found' USING ERRCODE = 'no_data_found'; END IF;
  IF c.status = 'erased' THEN RAISE EXCEPTION 'the contact is already erased' USING ERRCODE = 'check_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.privacy_requests r WHERE r.organization_id = c.organization_id AND r.contact_id = p_contact AND r.kind = 'erase' AND r.status = 'open') THEN
    RAISE EXCEPTION 'no open erase request for this contact' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.erased_addresses (organization_id, address_hash, contact_id, erased_by)
  VALUES (c.organization_id, public.privacy_address_hash(c.organization_id, c.address_key), c.id, app_current_user()) ON CONFLICT DO NOTHING;
  UPDATE public.send_attempts SET state = 'cancelled' WHERE contact_id = c.id AND organization_id = c.organization_id AND state = 'queued';
  UPDATE public.consent_events SET evidence = 'erased on a data-subject request' WHERE contact_id = c.id AND organization_id = c.organization_id;
  PERFORM public.redact_contact_drafts(c.id);
  UPDATE public.contacts SET address = 'erased-' || c.id::text || '@erased.invalid', address_key = 'erased-' || c.id::text || '@erased.invalid',
    display_name = NULL, source = 'erased', status = 'erased', updated_at = now() WHERE id = c.id AND organization_id = c.organization_id;
END $$;

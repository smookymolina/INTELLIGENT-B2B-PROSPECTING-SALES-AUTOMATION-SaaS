-- An opted-out contact can only return to active through a NEW granted consent recorded after the latest withdrawal
-- (the consent trigger does that). A person with prospects:manage cannot flip the status by hand.
CREATE OR REPLACE FUNCTION contacts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN RAISE EXCEPTION 'a contact starts active' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'opted_out' AND NEW.status <> 'opted_out' AND NOT EXISTS (
       SELECT 1 FROM consent_events g
       WHERE g.contact_id = NEW.id AND g.organization_id = NEW.organization_id AND g.event = 'granted'
         AND g.created_at >= COALESCE((SELECT max(w.created_at) FROM consent_events w WHERE w.contact_id = NEW.id AND w.organization_id = NEW.organization_id AND w.event = 'withdrawn'), '-infinity')
         AND (SELECT e.event FROM consent_events e WHERE e.contact_id = NEW.id AND e.organization_id = NEW.organization_id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) = 'granted') THEN
    RAISE EXCEPTION 'an opted-out contact only returns with a new recorded consent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

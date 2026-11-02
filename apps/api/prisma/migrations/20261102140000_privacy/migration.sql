-- CreateTable
CREATE TABLE "retention_policies" (
    "organization_id" UUID NOT NULL,
    "data_class" TEXT NOT NULL,
    "retention_days" INTEGER NOT NULL,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "retention_policies_pkey" PRIMARY KEY ("organization_id","data_class")
);

-- CreateTable
CREATE TABLE "privacy_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_by" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "note" TEXT,

    CONSTRAINT "privacy_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erased_addresses" (
    "organization_id" UUID NOT NULL,
    "address_hash" TEXT NOT NULL,
    "contact_id" UUID NOT NULL,
    "erased_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erased_addresses_pkey" PRIMARY KEY ("organization_id","address_hash")
);

-- CreateIndex
CREATE INDEX "privacy_requests_organization_id_status_requested_at_idx" ON "privacy_requests"("organization_id", "status", "requested_at");

-- CreateIndex
CREATE INDEX "privacy_requests_organization_id_contact_id_idx" ON "privacy_requests"("organization_id", "contact_id");

-- AddForeignKey
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_organization_id_contact_id_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erased_addresses" ADD CONSTRAINT "erased_addresses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===== P12-04 privacy: retention policy + data-subject requests. Everything here is org_admin only (privacy:manage). =====
ALTER TABLE retention_policies ADD CONSTRAINT retention_class CHECK (data_class IN ('import_jobs', 'sessions', 'invitations'));
ALTER TABLE retention_policies ADD CONSTRAINT retention_min_days CHECK (retention_days BETWEEN 30 AND 3650);
ALTER TABLE privacy_requests ADD CONSTRAINT privacy_kind CHECK (kind IN ('access', 'restrict', 'erase'));
ALTER TABLE privacy_requests ADD CONSTRAINT privacy_status CHECK (status IN ('open', 'completed', 'rejected'));
ALTER TABLE privacy_requests ADD CONSTRAINT privacy_closed CHECK ((status = 'open') = (completed_at IS NULL AND completed_by IS NULL));
ALTER TABLE privacy_requests ADD CONSTRAINT privacy_note CHECK (note IS NULL OR char_length(note) <= 500);
ALTER TABLE privacy_requests ADD CONSTRAINT privacy_reject_note CHECK (status <> 'rejected' OR char_length(btrim(coalesce(note, ''))) >= 3);

-- a contact may now be 'restricted' (processing limited: nothing is sent) or 'erased' (anonymized, irreversible)
ALTER TABLE contacts DROP CONSTRAINT contact_status;
ALTER TABLE contacts ADD CONSTRAINT contact_status CHECK (status IN ('active', 'opted_out', 'bounced', 'restricted', 'erased'));

ALTER TABLE retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE erased_addresses ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION app_can_manage_privacy() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT app_current_role() = 'org_admin' $$;
GRANT EXECUTE ON FUNCTION app_can_manage_privacy() TO app_runtime;

-- retention policies: no row = nothing is purged. No DELETE grant (a policy can be raised, never silently dropped).
GRANT SELECT, INSERT ON retention_policies TO app_runtime;
GRANT UPDATE (retention_days, updated_by, updated_at) ON retention_policies TO app_runtime;
CREATE POLICY retention_select ON retention_policies FOR SELECT TO app_runtime USING (organization_id = app_current_org() AND app_can_manage_privacy());
CREATE POLICY retention_insert ON retention_policies FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_can_manage_privacy() AND updated_by = app_current_user());
CREATE POLICY retention_update ON retention_policies FOR UPDATE TO app_runtime USING (organization_id = app_current_org() AND app_can_manage_privacy()) WITH CHECK (organization_id = app_current_org() AND updated_by = app_current_user());

-- data-subject requests
GRANT SELECT, INSERT ON privacy_requests TO app_runtime;
GRANT UPDATE (status, note) ON privacy_requests TO app_runtime;
CREATE POLICY privacy_select ON privacy_requests FOR SELECT TO app_runtime USING (organization_id = app_current_org() AND app_can_manage_privacy());
CREATE POLICY privacy_insert ON privacy_requests FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_can_manage_privacy() AND requested_by = app_current_user());
CREATE POLICY privacy_update ON privacy_requests FOR UPDATE TO app_runtime USING (organization_id = app_current_org() AND app_can_manage_privacy()) WITH CHECK (organization_id = app_current_org());
CREATE FUNCTION privacy_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN RAISE EXCEPTION 'a request starts open' USING ERRCODE = 'check_violation'; END IF;
    IF EXISTS (SELECT 1 FROM contacts c WHERE c.id = NEW.contact_id AND c.organization_id = NEW.organization_id AND c.status = 'erased') THEN
      RAISE EXCEPTION 'the contact is already erased' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM privacy_requests r WHERE r.organization_id = NEW.organization_id AND r.contact_id = NEW.contact_id AND r.kind = NEW.kind AND r.status = 'open') THEN
      RAISE EXCEPTION 'an open % request already exists for this contact', NEW.kind USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' THEN RAISE EXCEPTION 'a closed request cannot change' USING ERRCODE = 'check_violation'; END IF;
  IF (NEW.organization_id, NEW.contact_id, NEW.kind, NEW.requested_by, NEW.requested_at, NEW.due_at) IS DISTINCT FROM (OLD.organization_id, OLD.contact_id, OLD.kind, OLD.requested_by, OLD.requested_at, OLD.due_at) THEN
    RAISE EXCEPTION 'the request identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'open' THEN RAISE EXCEPTION 'an open request only moves to completed or rejected' USING ERRCODE = 'check_violation'; END IF;
  NEW.completed_by := app_current_user();
  NEW.completed_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER privacy_requests_guard BEFORE INSERT OR UPDATE ON privacy_requests FOR EACH ROW EXECUTE FUNCTION privacy_requests_guard();

-- erased-address fingerprints: org-salted SHA-256 of the lowercase address. Read-only for the app (rows are written by privacy_erase_contact).
GRANT SELECT ON erased_addresses TO app_runtime;
CREATE POLICY erased_select ON erased_addresses FOR SELECT TO app_runtime USING (organization_id = app_current_org());

CREATE FUNCTION privacy_address_hash(p_org uuid, p_address_key text) RETURNS text LANGUAGE sql IMMUTABLE
AS $$ SELECT encode(sha256(convert_to(p_org::text || ':' || p_address_key, 'UTF8')), 'hex') $$;
GRANT EXECUTE ON FUNCTION privacy_address_hash(uuid, text) TO app_runtime;

-- contacts: restricted/erased are entered and left ONLY through the functions below (owner context); an erased row is frozen;
-- an erased address can never be registered again.
CREATE OR REPLACE FUNCTION contacts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN RAISE EXCEPTION 'a contact starts active' USING ERRCODE = 'check_violation'; END IF;
    IF EXISTS (SELECT 1 FROM erased_addresses e WHERE e.organization_id = NEW.organization_id AND e.address_hash = privacy_address_hash(NEW.organization_id, NEW.address_key)) THEN
      RAISE EXCEPTION 'this address was erased on a data-subject request and cannot be contacted again' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'erased' AND (NEW.status, NEW.prospect_id, NEW.address, NEW.address_key, NEW.display_name, NEW.source) IS DISTINCT FROM (OLD.status, OLD.prospect_id, OLD.address, OLD.address_key, OLD.display_name, OLD.source) THEN
    RAISE EXCEPTION 'an erased contact cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (NEW.status IN ('restricted', 'erased') OR OLD.status = 'restricted') AND current_user = 'app_runtime' THEN
    RAISE EXCEPTION 'restriction and erasure go through the privacy workflow' USING ERRCODE = 'insufficient_privilege';
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

-- consent ledger: a withdrawal never lifts a restriction; nothing is recorded for an erased contact
CREATE OR REPLACE FUNCTION consent_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.event = 'withdrawn' THEN
    UPDATE public.contacts SET status = 'opted_out', updated_at = now() WHERE id = NEW.contact_id AND organization_id = NEW.organization_id AND status IN ('active', 'bounced');
  ELSE
    UPDATE public.contacts SET status = 'active', updated_at = now() WHERE id = NEW.contact_id AND organization_id = NEW.organization_id AND status = 'opted_out';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION consent_events_erased_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM contacts c WHERE c.id = NEW.contact_id AND c.organization_id = NEW.organization_id AND c.status = 'erased') THEN
    RAISE EXCEPTION 'the contact was erased: no consent can be recorded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_events_erased_guard BEFORE INSERT ON consent_events FOR EACH ROW EXECUTE FUNCTION consent_events_erased_guard();

CREATE OR REPLACE FUNCTION public_unsubscribe(p_org uuid, p_contact uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c public.contacts%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.contacts WHERE id = p_contact AND organization_id = p_org;
  IF NOT FOUND THEN RETURN false; END IF;
  IF c.status = 'erased' THEN RETURN true; END IF;
  IF c.status <> 'opted_out' THEN
    INSERT INTO public.consent_events (id, organization_id, contact_id, event, purpose, evidence, occurred_at, recorded_by)
    VALUES (gen_random_uuid(), p_org, p_contact, 'withdrawn', 'commercial_outreach', 'self-service unsubscribe link', now(), NULL);
  END IF;
  RETURN true;
END $$;

-- privacy workflow. Each function: org_admin of the CURRENT tenant only, and an OPEN request of the matching kind must exist.
CREATE FUNCTION privacy_restrict_contact(p_contact uuid) RETURNS void
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
  UPDATE public.contacts SET status = 'restricted', updated_at = now() WHERE id = p_contact AND organization_id = app_current_org();
  UPDATE public.send_attempts SET state = 'cancelled' WHERE contact_id = p_contact AND organization_id = app_current_org() AND state = 'queued';
END $$;

CREATE FUNCTION privacy_lift_restriction(p_contact uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s text; latest text; target text;
BEGIN
  IF app_current_role() IS DISTINCT FROM 'org_admin' OR app_current_org() IS NULL THEN RAISE EXCEPTION 'org_admin required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT status INTO s FROM public.contacts WHERE id = p_contact AND organization_id = app_current_org() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'contact not found' USING ERRCODE = 'no_data_found'; END IF;
  IF s <> 'restricted' THEN RAISE EXCEPTION 'the contact is not restricted' USING ERRCODE = 'check_violation'; END IF;
  SELECT event INTO latest FROM public.consent_events WHERE contact_id = p_contact AND organization_id = app_current_org() ORDER BY occurred_at DESC, created_at DESC LIMIT 1;
  target := CASE WHEN latest = 'withdrawn' THEN 'opted_out' ELSE 'active' END;
  UPDATE public.contacts SET status = target, updated_at = now() WHERE id = p_contact AND organization_id = app_current_org();
  RETURN target;
END $$;

CREATE FUNCTION privacy_erase_contact(p_contact uuid) RETURNS void
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
  UPDATE public.contacts SET address = 'erased-' || c.id::text || '@erased.invalid', address_key = 'erased-' || c.id::text || '@erased.invalid',
    display_name = NULL, source = 'erased', status = 'erased', updated_at = now() WHERE id = c.id AND organization_id = c.organization_id;
END $$;

-- retention purge for ONE class of the CURRENT tenant. Returns NULL without an explicit policy (nothing is purged by default).
-- p_dry = true only counts. Never touches audit, consent, suppressions, quotes or sales.
CREATE FUNCTION privacy_purge(p_class text, p_dry boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := app_current_org(); days integer; cutoff timestamptz; n integer;
BEGIN
  IF app_current_role() IS DISTINCT FROM 'org_admin' OR org IS NULL THEN RAISE EXCEPTION 'org_admin required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT retention_days INTO days FROM public.retention_policies WHERE organization_id = org AND data_class = p_class;
  IF NOT FOUND THEN RETURN NULL; END IF;
  cutoff := now() - make_interval(days => days);
  IF p_class = 'import_jobs' THEN
    IF p_dry THEN SELECT count(*) INTO n FROM public.import_jobs WHERE organization_id = org AND created_at < cutoff;
    ELSE WITH d AS (DELETE FROM public.import_jobs WHERE organization_id = org AND created_at < cutoff RETURNING 1) SELECT count(*) INTO n FROM d; END IF;
  ELSIF p_class = 'sessions' THEN
    IF p_dry THEN SELECT count(*) INTO n FROM public.sessions WHERE organization_id = org AND ((revoked_at IS NOT NULL AND revoked_at < cutoff) OR expires_at < cutoff);
    ELSE WITH d AS (DELETE FROM public.sessions WHERE organization_id = org AND ((revoked_at IS NOT NULL AND revoked_at < cutoff) OR expires_at < cutoff) RETURNING 1) SELECT count(*) INTO n FROM d; END IF;
  ELSIF p_class = 'invitations' THEN
    IF p_dry THEN SELECT count(*) INTO n FROM public.invitations WHERE organization_id = org AND COALESCE(accepted_at, revoked_at, expires_at) < cutoff;
    ELSE WITH d AS (DELETE FROM public.invitations WHERE organization_id = org AND COALESCE(accepted_at, revoked_at, expires_at) < cutoff RETURNING 1) SELECT count(*) INTO n FROM d; END IF;
  ELSE
    RAISE EXCEPTION 'unknown data class' USING ERRCODE = 'check_violation';
  END IF;
  RETURN jsonb_build_object('retentionDays', days, 'cutoff', cutoff, 'count', n);
END $$;

REVOKE ALL ON FUNCTION privacy_restrict_contact(uuid), privacy_lift_restriction(uuid), privacy_erase_contact(uuid), privacy_purge(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_restrict_contact(uuid), privacy_lift_restriction(uuid), privacy_erase_contact(uuid), privacy_purge(text, boolean) TO app_runtime;

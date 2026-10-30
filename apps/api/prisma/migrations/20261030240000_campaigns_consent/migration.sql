-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "address" TEXT NOT NULL,
    "address_key" TEXT NOT NULL,
    "display_name" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'commercial_outreach',
    "evidence" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "min_days_between" INTEGER NOT NULL DEFAULT 7,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "launched_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "send_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "skip_reason" TEXT,
    "provider" TEXT,
    "provider_message_id" TEXT,
    "attempted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "send_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contacts_organization_id_prospect_id_idx" ON "contacts"("organization_id", "prospect_id");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_organization_id_id_key" ON "contacts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_organization_id_channel_address_key_key" ON "contacts"("organization_id", "channel", "address_key");

-- CreateIndex
CREATE INDEX "consent_events_organization_id_contact_id_occurred_at_idx" ON "consent_events"("organization_id", "contact_id", "occurred_at");

-- CreateIndex
CREATE INDEX "campaigns_organization_id_state_idx" ON "campaigns"("organization_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_organization_id_id_key" ON "campaigns"("organization_id", "id");

-- CreateIndex
CREATE INDEX "send_attempts_organization_id_campaign_id_state_idx" ON "send_attempts"("organization_id", "campaign_id", "state");

-- CreateIndex
CREATE INDEX "send_attempts_organization_id_contact_id_state_idx" ON "send_attempts"("organization_id", "contact_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "send_attempts_campaign_id_contact_id_key" ON "send_attempts"("campaign_id", "contact_id");

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_prospect_id_fkey" FOREIGN KEY ("organization_id", "prospect_id") REFERENCES "prospects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_organization_id_contact_id_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_organization_id_campaign_id_fkey" FOREIGN KEY ("organization_id", "campaign_id") REFERENCES "campaigns"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_organization_id_contact_id_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===== Contacts, consent, campaigns (F7 domain; the only channel adapter is a sandbox). Consent is never inferred or defaulted. =====
ALTER TABLE contacts ADD CONSTRAINT contact_channel CHECK (channel IN ('email'));
ALTER TABLE contacts ADD CONSTRAINT contact_status CHECK (status IN ('active', 'opted_out', 'bounced'));
ALTER TABLE contacts ADD CONSTRAINT contact_address CHECK (address ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' AND char_length(address) <= 254 AND address_key = lower(address));
ALTER TABLE contacts ADD CONSTRAINT contact_source CHECK (char_length(btrim(source)) BETWEEN 3 AND 300);
ALTER TABLE consent_events ADD CONSTRAINT consent_event_kind CHECK (event IN ('granted', 'withdrawn'));
ALTER TABLE consent_events ADD CONSTRAINT consent_purpose CHECK (purpose IN ('commercial_outreach'));
ALTER TABLE consent_events ADD CONSTRAINT consent_evidence CHECK (char_length(btrim(evidence)) BETWEEN 3 AND 500);
ALTER TABLE consent_events ADD CONSTRAINT consent_not_future CHECK (occurred_at <= now() + interval '1 minute');
ALTER TABLE campaigns ADD CONSTRAINT campaign_state CHECK (state IN ('draft', 'approved', 'running', 'paused', 'completed', 'cancelled'));
ALTER TABLE campaigns ADD CONSTRAINT campaign_text CHECK (char_length(btrim(name)) BETWEEN 1 AND 120 AND char_length(btrim(subject)) BETWEEN 1 AND 200 AND char_length(body) BETWEEN 1 AND 5000);
ALTER TABLE campaigns ADD CONSTRAINT campaign_unsubscribe CHECK (position('{{unsubscribe_url}}' in body) > 0);
ALTER TABLE campaigns ADD CONSTRAINT campaign_min_days CHECK (min_days_between BETWEEN 0 AND 365);
ALTER TABLE send_attempts ADD CONSTRAINT attempt_state CHECK (state IN ('queued', 'sent', 'skipped', 'failed', 'cancelled'));
ALTER TABLE send_attempts ADD CONSTRAINT attempt_skip CHECK ((state = 'skipped') = (skip_reason IS NOT NULL));
ALTER TABLE send_attempts ADD CONSTRAINT attempt_sent CHECK ((state = 'sent') = (provider_message_id IS NOT NULL));

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_attempts ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION app_can_manage_campaigns() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT app_current_role() IN ('org_admin', 'sales_manager', 'campaign_manager') $$;
CREATE FUNCTION app_can_approve_campaigns() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT app_current_role() IN ('org_admin', 'sales_manager') $$;
GRANT EXECUTE ON FUNCTION app_can_manage_campaigns(), app_can_approve_campaigns() TO app_runtime;

-- contacts
GRANT SELECT, INSERT ON contacts TO app_runtime;
GRANT UPDATE (display_name, status, updated_at) ON contacts TO app_runtime;
CREATE POLICY contacts_select ON contacts FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY contacts_insert ON contacts FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_can_manage_prospects() AND created_by = app_current_user());
CREATE POLICY contacts_update ON contacts FOR UPDATE TO app_runtime USING (organization_id = app_current_org() AND app_can_manage_prospects()) WITH CHECK (organization_id = app_current_org());
CREATE FUNCTION contacts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN RAISE EXCEPTION 'a contact starts active' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contacts_guard BEFORE INSERT OR UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION contacts_guard();

-- consent ledger (append-only); the contact status follows the latest event
GRANT SELECT, INSERT ON consent_events TO app_runtime;
CREATE POLICY consent_select ON consent_events FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY consent_insert ON consent_events FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_can_manage_prospects() AND recorded_by = app_current_user());
CREATE FUNCTION consent_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.event = 'withdrawn' THEN
    UPDATE public.contacts SET status = 'opted_out', updated_at = now() WHERE id = NEW.contact_id AND organization_id = NEW.organization_id;
  ELSE
    UPDATE public.contacts SET status = 'active', updated_at = now() WHERE id = NEW.contact_id AND organization_id = NEW.organization_id AND status = 'opted_out';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION consent_apply() FROM PUBLIC;
CREATE TRIGGER consent_apply AFTER INSERT ON consent_events FOR EACH ROW EXECUTE FUNCTION consent_apply();

-- self-service unsubscribe: reached only after the API verified the signed link; minimal, idempotent, tenant-checked
CREATE FUNCTION public_unsubscribe(p_org uuid, p_contact uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c public.contacts%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.contacts WHERE id = p_contact AND organization_id = p_org;
  IF NOT FOUND THEN RETURN false; END IF;
  IF c.status <> 'opted_out' THEN
    INSERT INTO public.consent_events (id, organization_id, contact_id, event, purpose, evidence, occurred_at, recorded_by)
    VALUES (gen_random_uuid(), p_org, p_contact, 'withdrawn', 'commercial_outreach', 'self-service unsubscribe link', now(), NULL);
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public_unsubscribe(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_unsubscribe(uuid, uuid) TO app_runtime;

-- campaigns
GRANT SELECT, INSERT ON campaigns TO app_runtime;
GRANT UPDATE (name, subject, body, state, min_days_between, approved_by, approved_at, launched_at, updated_at) ON campaigns TO app_runtime;
CREATE POLICY campaigns_select ON campaigns FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY campaigns_insert ON campaigns FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_can_manage_campaigns() AND created_by = app_current_user());
CREATE POLICY campaigns_update ON campaigns FOR UPDATE TO app_runtime USING (organization_id = app_current_org() AND app_can_manage_campaigns()) WITH CHECK (organization_id = app_current_org());
CREATE FUNCTION campaigns_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'draft' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.launched_at IS NOT NULL THEN RAISE EXCEPTION 'a campaign starts as a draft' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state <> 'draft' AND (NEW.name, NEW.subject, NEW.body, NEW.min_days_between) IS DISTINCT FROM (OLD.name, OLD.subject, OLD.body, OLD.min_days_between) THEN
    RAISE EXCEPTION 'only a draft campaign can be edited' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT ((OLD.state = 'draft' AND NEW.state IN ('approved', 'cancelled'))
         OR (OLD.state = 'approved' AND NEW.state IN ('running', 'cancelled'))
         OR (OLD.state = 'running' AND NEW.state IN ('paused', 'completed', 'cancelled'))
         OR (OLD.state = 'paused' AND NEW.state IN ('running', 'cancelled'))) THEN
      RAISE EXCEPTION 'invalid campaign transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state = 'approved' THEN
      IF NOT app_can_approve_campaigns() THEN RAISE EXCEPTION 'this role cannot approve campaigns' USING ERRCODE = 'insufficient_privilege'; END IF;
      NEW.approved_by := app_current_user();
      NEW.approved_at := now();
    END IF;
    IF NEW.state = 'running' AND OLD.state = 'approved' THEN NEW.launched_at := now(); END IF;
  ELSIF (NEW.approved_by, NEW.approved_at, NEW.launched_at) IS DISTINCT FROM (OLD.approved_by, OLD.approved_at, OLD.launched_at) THEN
    RAISE EXCEPTION 'approval fields are set by the database' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaigns_guard BEFORE INSERT OR UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION campaigns_guard();

-- send attempts: the database refuses to mark an email as sent unless the contact is still reachable (defence in depth: no sending after opt-out)
GRANT SELECT, INSERT ON send_attempts TO app_runtime;
GRANT UPDATE (state, skip_reason, provider, provider_message_id, attempted_at) ON send_attempts TO app_runtime;
CREATE POLICY attempts_select ON send_attempts FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY attempts_insert ON send_attempts FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_can_manage_campaigns());
CREATE POLICY attempts_update ON send_attempts FOR UPDATE TO app_runtime USING (organization_id = app_current_org() AND app_can_manage_campaigns()) WITH CHECK (organization_id = app_current_org());
CREATE FUNCTION send_attempts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c contacts%ROWTYPE; k campaigns%ROWTYPE; p prospects%ROWTYPE; latest text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO k FROM campaigns WHERE id = NEW.campaign_id AND organization_id = NEW.organization_id;
    IF NOT FOUND OR k.state <> 'running' THEN RAISE EXCEPTION 'attempts are only queued for a running campaign' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.state <> 'queued' THEN RAISE EXCEPTION 'an attempt starts queued' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state <> 'queued' THEN RAISE EXCEPTION 'a closed attempt cannot change' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.state = 'sent' THEN
    SELECT * INTO c FROM contacts WHERE id = NEW.contact_id AND organization_id = NEW.organization_id;
    SELECT event INTO latest FROM consent_events WHERE contact_id = NEW.contact_id AND organization_id = NEW.organization_id ORDER BY occurred_at DESC, created_at DESC LIMIT 1;
    IF c.status <> 'active' OR latest IS DISTINCT FROM 'granted' THEN RAISE EXCEPTION 'no consent: the contact cannot be emailed' USING ERRCODE = 'check_violation'; END IF;
    SELECT * INTO p FROM prospects WHERE id = c.prospect_id AND organization_id = c.organization_id;
    IF p.status = 'disqualified' OR EXISTS (SELECT 1 FROM suppressions s WHERE s.organization_id = p.organization_id AND ((s.kind = 'domain' AND s.value_key = p.domain_key) OR (s.kind = 'name' AND s.value_key = p.name_key))) THEN
      RAISE EXCEPTION 'the prospect is on the do-not-contact list' USING ERRCODE = 'check_violation';
    END IF;
    NEW.attempted_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER send_attempts_guard BEFORE INSERT OR UPDATE ON send_attempts FOR EACH ROW EXECUTE FUNCTION send_attempts_guard();

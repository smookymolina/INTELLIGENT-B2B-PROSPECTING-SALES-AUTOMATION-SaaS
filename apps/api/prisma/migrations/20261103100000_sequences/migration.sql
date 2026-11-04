-- F7 sequences: chained steps with a delay, sent only inside a per-campaign time window (sandbox channel only; nothing here talks to a real provider).
-- The sequence is configured while the campaign is a draft (so approval covers the exact content), enrolment needs a running (= approved + launched) campaign,
-- and every delivery is re-checked by the database against the contact's current consent. Each table: RLS + FORCE by organization_id.

CREATE TABLE "campaign_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "timezone" TEXT NOT NULL,
    "window_start_min" INTEGER NOT NULL,
    "window_end_min" INTEGER NOT NULL,
    "weekdays" INTEGER[] NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "campaign_schedules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "campaign_schedules_tz_len" CHECK (char_length("timezone") BETWEEN 1 AND 64),
    CONSTRAINT "campaign_schedules_window" CHECK ("window_start_min" >= 0 AND "window_end_min" <= 1440 AND "window_end_min" > "window_start_min"),
    CONSTRAINT "campaign_schedules_weekdays" CHECK (cardinality("weekdays") BETWEEN 1 AND 7 AND "weekdays" <@ ARRAY[1,2,3,4,5,6,7])
);
CREATE UNIQUE INDEX "campaign_schedules_campaign_id_key" ON "campaign_schedules"("campaign_id");
CREATE UNIQUE INDEX "campaign_schedules_organization_id_id_key" ON "campaign_schedules"("organization_id", "id");
ALTER TABLE "campaign_schedules" ADD CONSTRAINT "campaign_schedules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "campaign_schedules" ADD CONSTRAINT "campaign_schedules_campaign_fkey" FOREIGN KEY ("organization_id", "campaign_id") REFERENCES "campaigns"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "sequence_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "step_no" INTEGER NOT NULL,
    "delay_hours" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sequence_steps_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sequence_steps_no" CHECK ("step_no" BETWEEN 1 AND 10),
    CONSTRAINT "sequence_steps_delay" CHECK ("delay_hours" BETWEEN 0 AND 2160 AND ("step_no" > 1 OR "delay_hours" = 0)),
    CONSTRAINT "sequence_steps_subject_len" CHECK (char_length("subject") BETWEEN 1 AND 200),
    CONSTRAINT "sequence_steps_body_len" CHECK (char_length("body") BETWEEN 1 AND 5000)
);
CREATE UNIQUE INDEX "sequence_steps_campaign_id_step_no_key" ON "sequence_steps"("campaign_id", "step_no");
CREATE INDEX "sequence_steps_organization_id_campaign_id_idx" ON "sequence_steps"("organization_id", "campaign_id");
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_campaign_fkey" FOREIGN KEY ("organization_id", "campaign_id") REFERENCES "campaigns"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "sequence_enrollments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "stop_reason" TEXT,
    "next_step" INTEGER NOT NULL DEFAULT 1,
    "next_due_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sequence_enrollments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sequence_enrollments_state" CHECK ("state" IN ('active', 'completed', 'stopped')),
    CONSTRAINT "sequence_enrollments_stop_reason" CHECK ("stop_reason" IS NULL OR "stop_reason" IN ('no_consent', 'opted_out', 'bounced', 'suppressed', 'recently_contacted', 'already_in_campaign', 'campaign_closed')),
    CONSTRAINT "sequence_enrollments_stop_pair" CHECK (("state" = 'stopped') = ("stop_reason" IS NOT NULL)),
    CONSTRAINT "sequence_enrollments_due_pair" CHECK (("state" = 'active') = ("next_due_at" IS NOT NULL)),
    CONSTRAINT "sequence_enrollments_step" CHECK ("next_step" BETWEEN 1 AND 10)
);
CREATE UNIQUE INDEX "sequence_enrollments_campaign_id_contact_id_key" ON "sequence_enrollments"("campaign_id", "contact_id");
CREATE UNIQUE INDEX "sequence_enrollments_organization_id_id_key" ON "sequence_enrollments"("organization_id", "id");
CREATE INDEX "sequence_enrollments_due_idx" ON "sequence_enrollments"("organization_id", "campaign_id", "state", "next_due_at");
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_campaign_fkey" FOREIGN KEY ("organization_id", "campaign_id") REFERENCES "campaigns"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_contact_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "sequence_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "step_no" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sequence_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sequence_deliveries_sandbox_only" CHECK ("provider" = 'sandbox')
);
CREATE UNIQUE INDEX "sequence_deliveries_enrollment_id_step_no_key" ON "sequence_deliveries"("enrollment_id", "step_no");
CREATE INDEX "sequence_deliveries_organization_id_contact_id_idx" ON "sequence_deliveries"("organization_id", "contact_id", "sent_at");
CREATE INDEX "sequence_deliveries_organization_id_campaign_id_idx" ON "sequence_deliveries"("organization_id", "campaign_id");
ALTER TABLE "sequence_deliveries" ADD CONSTRAINT "sequence_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sequence_deliveries" ADD CONSTRAINT "sequence_deliveries_enrollment_fkey" FOREIGN KEY ("organization_id", "enrollment_id") REFERENCES "sequence_enrollments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sequence_deliveries" ADD CONSTRAINT "sequence_deliveries_campaign_fkey" FOREIGN KEY ("organization_id", "campaign_id") REFERENCES "campaigns"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sequence_deliveries" ADD CONSTRAINT "sequence_deliveries_contact_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS + FORCE
ALTER TABLE campaign_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE sequence_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_steps FORCE ROW LEVEL SECURITY;
ALTER TABLE sequence_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_enrollments FORCE ROW LEVEL SECURITY;
ALTER TABLE sequence_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_deliveries FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, DELETE ON campaign_schedules TO app_runtime;
GRANT UPDATE (timezone, window_start_min, window_end_min, weekdays, updated_at) ON campaign_schedules TO app_runtime;
GRANT SELECT, INSERT, DELETE ON sequence_steps TO app_runtime;
GRANT SELECT, INSERT ON sequence_enrollments TO app_runtime;
GRANT UPDATE (state, stop_reason, next_step, next_due_at, updated_at) ON sequence_enrollments TO app_runtime;
GRANT SELECT, INSERT ON sequence_deliveries TO app_runtime;

CREATE POLICY campaign_schedules_select ON campaign_schedules FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY campaign_schedules_insert ON campaign_schedules FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_can_manage_campaigns() AND created_by = app_current_user());
CREATE POLICY campaign_schedules_update ON campaign_schedules FOR UPDATE TO app_runtime USING (organization_id = app_current_org() AND app_can_manage_campaigns()) WITH CHECK (organization_id = app_current_org());
CREATE POLICY campaign_schedules_delete ON campaign_schedules FOR DELETE TO app_runtime USING (organization_id = app_current_org() AND app_can_manage_campaigns());

CREATE POLICY sequence_steps_select ON sequence_steps FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY sequence_steps_insert ON sequence_steps FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_can_manage_campaigns());
CREATE POLICY sequence_steps_delete ON sequence_steps FOR DELETE TO app_runtime USING (organization_id = app_current_org() AND app_can_manage_campaigns());

CREATE POLICY sequence_enrollments_select ON sequence_enrollments FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY sequence_enrollments_insert ON sequence_enrollments FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_can_manage_campaigns() AND created_by = app_current_user());
CREATE POLICY sequence_enrollments_update ON sequence_enrollments FOR UPDATE TO app_runtime USING (organization_id = app_current_org() AND app_can_manage_campaigns()) WITH CHECK (organization_id = app_current_org());

CREATE POLICY sequence_deliveries_select ON sequence_deliveries FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY sequence_deliveries_insert ON sequence_deliveries FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_can_manage_campaigns());

-- The sequence (schedule + steps) is editable only while the campaign is a draft: approval always covers the exact content that will be sent.
CREATE FUNCTION sequence_config_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid; oid uuid; st text;
BEGIN
  IF TG_OP = 'DELETE' THEN cid := OLD.campaign_id; oid := OLD.organization_id; ELSE cid := NEW.campaign_id; oid := NEW.organization_id; END IF;
  SELECT state INTO st FROM campaigns WHERE id = cid AND organization_id = oid;
  IF st IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'only a draft campaign can change its sequence' USING ERRCODE = 'check_violation'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.campaign_id) IS DISTINCT FROM (OLD.organization_id, OLD.campaign_id) THEN
    RAISE EXCEPTION 'the campaign of a schedule is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaign_schedules_guard BEFORE INSERT OR UPDATE OR DELETE ON campaign_schedules FOR EACH ROW EXECUTE FUNCTION sequence_config_guard();
CREATE TRIGGER sequence_steps_guard BEFORE INSERT OR DELETE ON sequence_steps FOR EACH ROW EXECUTE FUNCTION sequence_config_guard();

-- Enrolment state machine: active -> completed | stopped (terminal). While active, the only legal move is to the next step.
CREATE FUNCTION sequence_enrollments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'enrolments are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'active' OR NEW.next_step <> 1 THEN RAISE EXCEPTION 'an enrolment starts active at step 1' USING ERRCODE = 'check_violation'; END IF;
    SELECT state INTO st FROM campaigns WHERE id = NEW.campaign_id AND organization_id = NEW.organization_id;
    IF st IS DISTINCT FROM 'running' THEN RAISE EXCEPTION 'only a running campaign enrols contacts' USING ERRCODE = 'check_violation'; END IF;
    IF NOT EXISTS (SELECT 1 FROM sequence_steps WHERE campaign_id = NEW.campaign_id AND organization_id = NEW.organization_id AND step_no = 1) THEN
      RAISE EXCEPTION 'the campaign has no sequence' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.organization_id, NEW.campaign_id, NEW.contact_id, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.organization_id, OLD.campaign_id, OLD.contact_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'enrolment identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state <> 'active' THEN RAISE EXCEPTION 'invalid enrolment transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation'; END IF;
  IF NEW.state = 'active' THEN
    IF NEW.next_step <> OLD.next_step AND NEW.next_step <> OLD.next_step + 1 THEN RAISE EXCEPTION 'a sequence advances one step at a time' USING ERRCODE = 'check_violation'; END IF;
  ELSIF NEW.next_step <> OLD.next_step THEN
    RAISE EXCEPTION 'a closed enrolment keeps its step' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sequence_enrollments_guard BEFORE INSERT OR UPDATE OR DELETE ON sequence_enrollments FOR EACH ROW EXECUTE FUNCTION sequence_enrollments_guard();

-- A delivery is append-only and only valid for the enrolment's current step, in a running campaign, to a contact that still has consent.
CREATE FUNCTION sequence_deliveries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e sequence_enrollments%ROWTYPE; cstate text; cstatus text; lastev text;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'deliveries are append-only' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO e FROM sequence_enrollments WHERE id = NEW.enrollment_id AND organization_id = NEW.organization_id;
  IF NOT FOUND OR e.state <> 'active' OR e.next_step <> NEW.step_no OR e.campaign_id <> NEW.campaign_id OR e.contact_id <> NEW.contact_id THEN
    RAISE EXCEPTION 'delivery does not match the enrolment current step' USING ERRCODE = 'check_violation';
  END IF;
  SELECT state INTO cstate FROM campaigns WHERE id = NEW.campaign_id AND organization_id = NEW.organization_id;
  IF cstate IS DISTINCT FROM 'running' THEN RAISE EXCEPTION 'only a running campaign delivers' USING ERRCODE = 'check_violation'; END IF;
  SELECT status INTO cstatus FROM contacts WHERE id = NEW.contact_id AND organization_id = NEW.organization_id;
  SELECT event INTO lastev FROM consent_events WHERE contact_id = NEW.contact_id AND organization_id = NEW.organization_id ORDER BY occurred_at DESC, created_at DESC LIMIT 1;
  IF cstatus IS DISTINCT FROM 'active' OR lastev IS DISTINCT FROM 'granted' THEN RAISE EXCEPTION 'no consent or do-not-contact for this contact' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sequence_deliveries_guard BEFORE INSERT OR UPDATE OR DELETE ON sequence_deliveries FOR EACH ROW EXECUTE FUNCTION sequence_deliveries_guard();

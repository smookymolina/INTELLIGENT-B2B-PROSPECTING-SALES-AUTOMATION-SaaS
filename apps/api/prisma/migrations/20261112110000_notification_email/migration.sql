-- Notification e-mail: a SECOND SMTP account per organization (purpose "notifications", separate from the "outreach" account in email_settings),
-- up to 5 destination addresses, and per-type switches. Existing email_settings rows stay the outreach account untouched.
CREATE TABLE "notification_smtp_settings" (
    "organization_id" UUID NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "secure" BOOLEAN NOT NULL,
    "username" TEXT NOT NULL,
    "password_enc" TEXT NOT NULL,
    "from_name" TEXT,
    "from_email" TEXT NOT NULL,
    "reply_to" TEXT,
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_smtp_settings_pkey" PRIMARY KEY ("organization_id"),
    CONSTRAINT "notification_smtp_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT notification_smtp_port CHECK (port IN (25, 465, 587, 2525)),
    CONSTRAINT notification_smtp_host CHECK (char_length(host) BETWEEN 1 AND 253 AND host !~ '[[:space:][:cntrl:]]'),
    CONSTRAINT notification_smtp_username CHECK (char_length(username) BETWEEN 1 AND 254),
    CONSTRAINT notification_smtp_from_email CHECK (char_length(from_email) BETWEEN 3 AND 254 AND from_email !~ '[[:space:][:cntrl:]<>]'),
    CONSTRAINT notification_smtp_from_name CHECK (from_name IS NULL OR (char_length(from_name) BETWEEN 1 AND 120 AND from_name !~ '[[:cntrl:]<>"]')),
    CONSTRAINT notification_smtp_reply_to CHECK (reply_to IS NULL OR (char_length(reply_to) BETWEEN 3 AND 254 AND reply_to !~ '[[:space:][:cntrl:]<>]')),
    CONSTRAINT notification_smtp_password CHECK (password_enc LIKE 'v1.%')
);

CREATE TABLE "notification_email_destinations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "last_test_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_email_destinations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_email_destinations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT notification_dest_address CHECK (char_length(address) BETWEEN 3 AND 254 AND address = lower(address) AND address ~ '^[^[:space:][:cntrl:]<>@]+@[^[:space:][:cntrl:]<>@]+$')
);
CREATE UNIQUE INDEX "notification_email_destinations_organization_id_address_key" ON "notification_email_destinations"("organization_id", "address");

CREATE TABLE "notification_email_rules" (
    "organization_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_email_rules_pkey" PRIMARY KEY ("organization_id", "type"),
    CONSTRAINT "notification_email_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT notification_email_rule_type CHECK (type IN ('task_overdue', 'task_due_soon', 'lead_assigned', 'opportunity_assigned', 'sla_breached', 'draft_pending_review'))
);

-- At most 5 destinations per organization (serialised per organization so two concurrent inserts cannot both pass).
CREATE FUNCTION notification_dest_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('notification_dest:' || NEW.organization_id::text, 0));
  IF (SELECT count(*) FROM notification_email_destinations WHERE organization_id = NEW.organization_id) >= 5 THEN
    RAISE EXCEPTION 'at most 5 notification destinations per organization' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_dest_limit BEFORE INSERT ON notification_email_destinations FOR EACH ROW EXECUTE FUNCTION notification_dest_limit();

ALTER TABLE notification_smtp_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_smtp_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_email_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_email_destinations FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_email_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_email_rules FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, DELETE ON notification_smtp_settings TO app_runtime;
GRANT UPDATE (host, port, secure, username, password_enc, from_name, from_email, reply_to, verified_at, updated_at) ON notification_smtp_settings TO app_runtime;
GRANT SELECT, INSERT, DELETE ON notification_email_destinations TO app_runtime;
GRANT UPDATE (last_test_at) ON notification_email_destinations TO app_runtime;
GRANT SELECT, INSERT ON notification_email_rules TO app_runtime;
GRANT UPDATE (enabled, updated_at) ON notification_email_rules TO app_runtime;

-- Reads: anyone in the organization (producers check whether to queue an e-mail). Writes: org_admin only (the worker acts as one).
CREATE POLICY notification_smtp_select ON notification_smtp_settings FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY notification_smtp_insert ON notification_smtp_settings FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_current_role() = 'org_admin');
CREATE POLICY notification_smtp_update ON notification_smtp_settings FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_current_role() = 'org_admin') WITH CHECK (organization_id = app_current_org() AND app_current_role() = 'org_admin');
CREATE POLICY notification_smtp_delete ON notification_smtp_settings FOR DELETE TO app_runtime USING (organization_id = app_current_org() AND app_current_role() = 'org_admin');

CREATE POLICY notification_dest_select ON notification_email_destinations FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY notification_dest_insert ON notification_email_destinations FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_current_role() = 'org_admin');
CREATE POLICY notification_dest_update ON notification_email_destinations FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_current_role() = 'org_admin') WITH CHECK (organization_id = app_current_org() AND app_current_role() = 'org_admin');
CREATE POLICY notification_dest_delete ON notification_email_destinations FOR DELETE TO app_runtime USING (organization_id = app_current_org() AND app_current_role() = 'org_admin');

CREATE POLICY notification_rules_select ON notification_email_rules FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY notification_rules_insert ON notification_email_rules FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_current_role() = 'org_admin');
CREATE POLICY notification_rules_update ON notification_email_rules FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_current_role() = 'org_admin') WITH CHECK (organization_id = app_current_org() AND app_current_role() = 'org_admin');

-- Any member's request (a seller assigning a lead, say) may queue the e-mail job of the notification it just created; nothing else about jobs opens up.
CREATE POLICY jobs_notification_email_insert ON jobs FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND type = 'notifications.send_email' AND state = 'queued' AND attempts = 0 AND locked_by IS NULL
              AND payload ->> 'kind' = 'notification' AND dedupe_key ~ '^[0-9a-f-]{36}$');

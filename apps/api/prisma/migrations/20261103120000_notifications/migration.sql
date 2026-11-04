-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "resource_type" TEXT,
    "resource_id" UUID,
    "dedupe_key" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'sandbox',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(6),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("organization_id", "user_id", "type")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_organization_id_user_id_dedupe_key_key" ON "notifications"("organization_id", "user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "notifications_organization_id_user_id_created_at_id_idx" ON "notifications"("organization_id", "user_id", "created_at" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- In-app inbox only (channel sandbox): nothing here sends email or WhatsApp.
ALTER TABLE notifications ADD CONSTRAINT notification_channel CHECK (channel = 'sandbox');
ALTER TABLE notifications ADD CONSTRAINT notification_type CHECK (type IN ('task_overdue', 'task_due_soon', 'lead_assigned', 'opportunity_assigned', 'sla_breached', 'draft_pending_review'));
ALTER TABLE notification_preferences ADD CONSTRAINT notification_pref_type CHECK (type IN ('task_overdue', 'task_due_soon', 'lead_assigned', 'opportunity_assigned', 'sla_breached', 'draft_pending_review'));
ALTER TABLE notifications ADD CONSTRAINT notification_title CHECK (char_length(btrim(title)) BETWEEN 1 AND 200);

-- Row-level security: organization AND recipient. A user only reads and updates their own notifications.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON notifications TO app_runtime;
GRANT UPDATE (read_at) ON notifications TO app_runtime;
GRANT SELECT, INSERT ON notification_preferences TO app_runtime;
GRANT UPDATE (enabled, updated_at) ON notification_preferences TO app_runtime;

CREATE POLICY notifications_select ON notifications FOR SELECT TO app_runtime
  USING (organization_id = app_current_org() AND user_id = app_current_user());
-- Other modules create notifications for a colleague in the same organization (e.g. an assignment); the recipient must be an active member.
CREATE POLICY notifications_insert ON notifications FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_current_user() IS NOT NULL);
CREATE POLICY notifications_update ON notifications FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND user_id = app_current_user())
  WITH CHECK (organization_id = app_current_org() AND user_id = app_current_user());

-- Preferences are readable inside the organization (so producers can skip disabled types) but only the owner writes them.
CREATE POLICY notification_prefs_select ON notification_preferences FOR SELECT TO app_runtime
  USING (organization_id = app_current_org());
CREATE POLICY notification_prefs_insert ON notification_preferences FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND user_id = app_current_user());
CREATE POLICY notification_prefs_update ON notification_preferences FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND user_id = app_current_user())
  WITH CHECK (organization_id = app_current_org() AND user_id = app_current_user());

CREATE FUNCTION notifications_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = NEW.organization_id AND m.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'recipient is not a member of the organization' USING ERRCODE = 'check_violation';
    END IF;
    NEW.read_at := NULL;
    RETURN NEW;
  END IF;
  IF OLD.read_at IS NOT NULL THEN NEW.read_at := OLD.read_at; ELSE NEW.read_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notifications_guard BEFORE INSERT OR UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION notifications_guard();

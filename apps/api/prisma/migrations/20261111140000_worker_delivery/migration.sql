-- Delivery of an approved email draft. A person asks for it explicitly; only the worker sends. One delivery per draft.
CREATE TABLE "draft_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "skip_reason" TEXT,
    "provider" TEXT,
    "provider_message_id" TEXT,
    "requested_by" UUID NOT NULL,
    "attempted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "draft_deliveries_state" CHECK ("state" IN ('queued', 'sent', 'failed', 'skipped')),
    CONSTRAINT "draft_deliveries_sent" CHECK (("state" = 'sent') = ("provider_message_id" IS NOT NULL)),
    CONSTRAINT "draft_deliveries_skip" CHECK (("state" = 'skipped') = ("skip_reason" IS NOT NULL)),
    CONSTRAINT "draft_deliveries_provider" CHECK ("provider" IS NULL OR "provider" IN ('sandbox', 'smtp'))
);
CREATE UNIQUE INDEX "draft_deliveries_organization_id_draft_id_key" ON "draft_deliveries"("organization_id", "draft_id");
CREATE INDEX "draft_deliveries_organization_id_state_idx" ON "draft_deliveries"("organization_id", "state", "created_at");
CREATE INDEX "draft_deliveries_organization_id_contact_id_idx" ON "draft_deliveries"("organization_id", "contact_id", "attempted_at");
ALTER TABLE "draft_deliveries" ADD CONSTRAINT "draft_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "draft_deliveries" ADD CONSTRAINT "draft_deliveries_draft_fkey" FOREIGN KEY ("organization_id", "draft_id") REFERENCES "message_drafts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "draft_deliveries" ADD CONSTRAINT "draft_deliveries_contact_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE draft_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_deliveries FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON draft_deliveries TO app_runtime;
GRANT UPDATE (state, skip_reason, provider, provider_message_id, attempted_at) ON draft_deliveries TO app_runtime;
CREATE POLICY draft_deliveries_select ON draft_deliveries FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY draft_deliveries_insert ON draft_deliveries FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND requested_by = app_current_user());
CREATE POLICY draft_deliveries_update ON draft_deliveries FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());

-- A delivery only exists for an approved email draft, and a sent one never changes again.
CREATE FUNCTION draft_deliveries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'draft deliveries are never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM message_drafts d WHERE d.organization_id = NEW.organization_id AND d.id = NEW.draft_id AND d.status = 'approved' AND d.channel = 'email' AND d.contact_id = NEW.contact_id) THEN
      RAISE EXCEPTION 'only an approved email draft can be delivered';
    END IF;
    IF NEW.state <> 'queued' THEN RAISE EXCEPTION 'a delivery starts queued'; END IF;
  ELSIF OLD.state = 'sent' THEN
    RAISE EXCEPTION 'a sent delivery is final';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER draft_deliveries_guard BEFORE INSERT OR UPDATE OR DELETE ON draft_deliveries FOR EACH ROW EXECUTE FUNCTION draft_deliveries_guard();

-- The worker now also dispatches single-email campaigns and approved drafts.
ALTER TABLE jobs DROP CONSTRAINT jobs_type;
ALTER TABLE jobs ADD CONSTRAINT jobs_type CHECK (type IN ('sequence.run_due', 'notifications.scan_due', 'retention.purge', 'campaign.dispatch', 'draft.send_queued'));

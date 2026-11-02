-- Personalised message drafts (email / WhatsApp template) with human approval. A draft is content, never a send: there is no sending path here.
-- Content is immutable once created; only pending_review -> approved|rejected, stamped by the database with who decided and when.
CREATE TABLE "message_drafts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "evidence_refs" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending_review',
    "author_kind" TEXT NOT NULL DEFAULT 'human',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,
    CONSTRAINT "message_drafts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "message_drafts_channel" CHECK ("channel" IN ('email', 'whatsapp')),
    CONSTRAINT "message_drafts_status" CHECK ("status" IN ('pending_review', 'approved', 'rejected')),
    CONSTRAINT "message_drafts_author_kind" CHECK ("author_kind" IN ('human', 'mcp')),
    CONSTRAINT "message_drafts_subject_rule" CHECK (("channel" = 'email' AND "subject" IS NOT NULL AND char_length("subject") BETWEEN 1 AND 200) OR ("channel" = 'whatsapp' AND "subject" IS NULL)),
    CONSTRAINT "message_drafts_body_len" CHECK (char_length("body") >= 1 AND char_length("body") <= CASE WHEN "channel" = 'whatsapp' THEN 1024 ELSE 5000 END),
    CONSTRAINT "message_drafts_refs_len" CHECK (cardinality("evidence_refs") <= 20),
    CONSTRAINT "message_drafts_decision_pair" CHECK (("status" = 'pending_review') = ("decided_at" IS NULL AND "decided_by" IS NULL)),
    CONSTRAINT "message_drafts_reject_note" CHECK ("status" <> 'rejected' OR ("decision_note" IS NOT NULL AND char_length("decision_note") BETWEEN 1 AND 500)),
    CONSTRAINT "message_drafts_note_len" CHECK ("decision_note" IS NULL OR char_length("decision_note") <= 500)
);
CREATE UNIQUE INDEX "message_drafts_organization_id_id_key" ON "message_drafts"("organization_id", "id");
CREATE INDEX "message_drafts_organization_id_status_id_idx" ON "message_drafts"("organization_id", "status", "id");
CREATE INDEX "message_drafts_organization_id_contact_id_idx" ON "message_drafts"("organization_id", "contact_id");
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_contact_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A contact can now be a WhatsApp contact (consent is per contact, and a contact belongs to one channel). The email path is unchanged.
ALTER TABLE contacts DROP CONSTRAINT contact_channel;
ALTER TABLE contacts ADD CONSTRAINT contact_channel CHECK (channel IN ('email', 'whatsapp'));
ALTER TABLE contacts DROP CONSTRAINT contact_address;
ALTER TABLE contacts ADD CONSTRAINT contact_address CHECK (
  ((channel = 'email' AND address ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') OR (channel = 'whatsapp' AND address ~ '^\+[1-9][0-9]{7,14}$'))
  AND char_length(address) <= 254 AND address_key = lower(address));

ALTER TABLE message_drafts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON message_drafts TO app_runtime;
GRANT UPDATE (status, decided_by, decided_at, decision_note) ON message_drafts TO app_runtime;
CREATE POLICY message_drafts_select ON message_drafts FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY message_drafts_insert ON message_drafts FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_campaigns() AND created_by = app_current_user());
CREATE POLICY message_drafts_update ON message_drafts FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_can_approve_campaigns()) WITH CHECK (organization_id = app_current_org());

CREATE FUNCTION message_drafts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'message drafts are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending_review' THEN RAISE EXCEPTION 'a draft starts pending review' USING ERRCODE = 'check_violation'; END IF;
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
CREATE TRIGGER message_drafts_guard BEFORE INSERT OR UPDATE OR DELETE ON message_drafts FOR EACH ROW EXECUTE FUNCTION message_drafts_guard();

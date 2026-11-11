-- WhatsApp manual: el sistema solo genera el enlace wa.me; la persona envia desde su propio numero y lo marca. Registro solo-anexar.
CREATE TABLE "whatsapp_manual_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "whatsapp_manual_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "whatsapp_manual_events_kind" CHECK ("kind" IN ('link', 'sent'))
);
CREATE UNIQUE INDEX "whatsapp_manual_events_one_sent" ON "whatsapp_manual_events"("organization_id", "draft_id") WHERE "kind" = 'sent';
CREATE INDEX "whatsapp_manual_events_user_idx" ON "whatsapp_manual_events"("organization_id", "user_id", "created_at");
CREATE INDEX "whatsapp_manual_events_draft_idx" ON "whatsapp_manual_events"("organization_id", "draft_id");
ALTER TABLE "whatsapp_manual_events" ADD CONSTRAINT "whatsapp_manual_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "whatsapp_manual_events" ADD CONSTRAINT "whatsapp_manual_events_draft_fkey" FOREIGN KEY ("organization_id", "draft_id") REFERENCES "message_drafts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "whatsapp_manual_events" ADD CONSTRAINT "whatsapp_manual_events_contact_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE whatsapp_manual_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_manual_events FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON whatsapp_manual_events TO app_runtime;
CREATE POLICY whatsapp_manual_events_select ON whatsapp_manual_events FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY whatsapp_manual_events_insert ON whatsapp_manual_events FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND user_id = app_current_user());

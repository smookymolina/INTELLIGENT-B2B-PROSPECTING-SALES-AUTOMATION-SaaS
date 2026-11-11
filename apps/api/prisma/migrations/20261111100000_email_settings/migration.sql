-- Per-organization SMTP settings: every tenant sends with its own mailbox. The password is stored encrypted (AES-256-GCM, ENCRYPTION_KEY).
CREATE TABLE "email_settings" (
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

    CONSTRAINT "email_settings_pkey" PRIMARY KEY ("organization_id")
);

ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE email_settings
  ADD CONSTRAINT email_settings_port CHECK (port IN (25, 465, 587, 2525)),
  ADD CONSTRAINT email_settings_host CHECK (char_length(host) BETWEEN 1 AND 253 AND host !~ '[[:space:][:cntrl:]]'),
  ADD CONSTRAINT email_settings_username CHECK (char_length(username) BETWEEN 1 AND 254),
  ADD CONSTRAINT email_settings_from_email CHECK (char_length(from_email) BETWEEN 3 AND 254 AND from_email !~ '[[:space:][:cntrl:]<>]'),
  ADD CONSTRAINT email_settings_from_name CHECK (from_name IS NULL OR (char_length(from_name) BETWEEN 1 AND 120 AND from_name !~ '[[:cntrl:]<>"]')),
  ADD CONSTRAINT email_settings_reply_to CHECK (reply_to IS NULL OR (char_length(reply_to) BETWEEN 3 AND 254 AND reply_to !~ '[[:space:][:cntrl:]<>]')),
  ADD CONSTRAINT email_settings_password CHECK (password_enc LIKE 'v1.%');

ALTER TABLE email_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_settings FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, DELETE ON email_settings TO app_runtime;
GRANT UPDATE (host, port, secure, username, password_enc, from_name, from_email, reply_to, verified_at, updated_at) ON email_settings TO app_runtime;

CREATE POLICY email_settings_select ON email_settings FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY email_settings_insert ON email_settings FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org());
CREATE POLICY email_settings_update ON email_settings FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
CREATE POLICY email_settings_delete ON email_settings FOR DELETE TO app_runtime USING (organization_id = app_current_org());

-- Sequences may now deliver through the tenant's own SMTP, not only the sandbox.
ALTER TABLE sequence_deliveries DROP CONSTRAINT sequence_deliveries_sandbox_only;
ALTER TABLE sequence_deliveries ADD CONSTRAINT sequence_deliveries_provider CHECK (provider IN ('sandbox', 'smtp'));

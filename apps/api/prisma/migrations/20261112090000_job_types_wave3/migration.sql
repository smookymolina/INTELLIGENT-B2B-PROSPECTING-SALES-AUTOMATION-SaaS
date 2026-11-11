-- Two new job types for wave 3 (shared migration so parallel work does not redefine the constraint twice).
ALTER TABLE jobs DROP CONSTRAINT jobs_type;
ALTER TABLE jobs ADD CONSTRAINT jobs_type CHECK (type IN ('sequence.run_due', 'notifications.scan_due', 'retention.purge', 'campaign.dispatch', 'draft.send_queued', 'prospects.expire_due', 'notifications.send_email'));

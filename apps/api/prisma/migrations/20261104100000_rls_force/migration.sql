-- RLS hardening: FORCE ROW LEVEL SECURITY on every tenant table where it is provably safe (ADR-030 in context/PROJECT_DECISIONS.md).
--
-- Why: without FORCE the table OWNER bypasses RLS. The application never connects as the owner (login role `app_login`
-- is NOSUPERUSER/NOBYPASSRLS, not an owner, and drops to `app_runtime` per request), so FORCE is defence in depth against
-- a deployment that points DATABASE_URL at the migration owner or a code path that forgets SET LOCAL ROLE.
--
-- Why not all tables: the policies are `TO app_runtime` only. Under FORCE the owner has NO applicable policy, so any
-- SECURITY DEFINER function (which runs as the owner) that touches the table would see zero rows when the owner is not a
-- superuser. Those tables stay WITHOUT force and are listed below with the function that needs them.
--
-- Already forced by their own migrations: campaign_schedules, sequence_steps, sequence_enrollments, sequence_deliveries,
-- notifications, notification_preferences.
--
-- EXCEPTIONS (RLS enabled, deliberately NOT forced; each is read/written by a SECURITY DEFINER function or by a trigger
-- fired from one):
--   organizations, users, memberships, sessions        auth_resolve_session, auth_lookup_user, auth_list_*, invitation_accept, auth_change_password
--   login_attempts                                      auth_login_begin / auth_login_succeeded
--   idempotency_keys                                    idem_begin / idem_complete / idem_release
--   invitations, audit_events                           invitation_accept, privacy_purge
--   contacts, consent_events, send_attempts             consent_apply, public_unsubscribe, privacy_restrict_contact, privacy_lift_restriction, privacy_erase_contact
--   privacy_requests, erased_addresses                  privacy_* functions
--   message_drafts, draft_redaction_marks, campaigns    redact_contact_drafts, message_drafts_guard (definer)
--   import_jobs, retention_policies                     privacy_purge
--   prospects, leads, suppressions                      suppressions_reject_leads (definer) and the guards it fires (leads_guard reads suppressions)
--   opportunity_stage_history                           opportunities_history (definer trigger)
DO $$
DECLARE
  t text;
  forced text[] := ARRAY[
    'ai_budgets', 'ai_runs', 'branches', 'catalog_categories', 'catalog_item_versions', 'catalog_items',
    'intent_assessments', 'lead_settings', 'opportunities', 'opportunity_assignments', 'opportunity_notes', 'opportunity_tasks',
    'organization_profiles', 'price_list_entries', 'price_lists', 'prospect_attributes', 'prospect_merges', 'prospect_sources',
    'quote_counters', 'quote_lines', 'quote_settings', 'quotes', 'routing_settings', 'sales', 'score_results',
    'scoring_model_versions', 'seller_pool'
  ];
BEGIN
  FOREACH t IN ARRAY forced LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

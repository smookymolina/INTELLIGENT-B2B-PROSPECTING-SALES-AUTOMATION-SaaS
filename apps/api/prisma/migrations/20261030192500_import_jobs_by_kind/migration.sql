-- Import jobs are visible/writable according to WHAT was imported: catalog jobs need catalog managers, prospect jobs need prospect managers.
DROP POLICY import_jobs_select ON import_jobs;
DROP POLICY import_jobs_insert ON import_jobs;
CREATE POLICY import_jobs_select ON import_jobs FOR SELECT TO app_runtime USING (
  organization_id = app_current_org()
  AND ((kind = 'catalog_items' AND app_can_manage_catalog()) OR (kind = 'prospects' AND app_can_manage_prospects()))
);
CREATE POLICY import_jobs_insert ON import_jobs FOR INSERT TO app_runtime WITH CHECK (
  organization_id = app_current_org() AND created_by = app_current_user()
  AND ((kind = 'catalog_items' AND app_can_manage_catalog()) OR (kind = 'prospects' AND app_can_manage_prospects()))
);

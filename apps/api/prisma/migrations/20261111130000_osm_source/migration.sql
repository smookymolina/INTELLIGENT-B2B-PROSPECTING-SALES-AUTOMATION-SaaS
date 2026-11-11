-- OpenStreetMap discovery: a third provenance value. Nothing else is relaxed.
ALTER TABLE prospect_sources DROP CONSTRAINT prospect_sources_type;
ALTER TABLE prospect_sources ADD CONSTRAINT prospect_sources_type CHECK (source_type IN ('manual', 'csv_import', 'openstreetmap'));

ALTER TABLE prospect_attributes DROP CONSTRAINT prospect_attributes_source;
ALTER TABLE prospect_attributes ADD CONSTRAINT prospect_attributes_source CHECK (source IN ('manual', 'csv_import', 'openstreetmap'));

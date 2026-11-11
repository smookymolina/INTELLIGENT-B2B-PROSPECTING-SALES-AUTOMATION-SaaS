-- Visibilidad por propietario (decision del duenio, 3 roles): GERENTE (org_admin) ve y reasigna todo lo de su organizacion;
-- USUARIO (seller) ve SOLO los prospectos que trajo, sus leads, y los contactos/borradores colgados de ellos. Resto de roles: sin cambios.
-- Contactos y borradores heredan la visibilidad del prospecto via EXISTS (el RLS de prospects ya filtra la subconsulta).

ALTER TABLE prospects ADD COLUMN owner_user_id uuid;
ALTER TABLE leads ADD COLUMN owner_user_id uuid;

-- Backfill: el duenio de la tabla no tiene politica bajo FORCE, asi que se desactiva un instante dentro de la migracion.
ALTER TABLE prospects NO FORCE ROW LEVEL SECURITY;
ALTER TABLE leads NO FORCE ROW LEVEL SECURITY;
UPDATE prospects SET owner_user_id = created_by;
UPDATE leads l SET owner_user_id = COALESCE((SELECT p.owner_user_id FROM prospects p WHERE p.id = l.prospect_id), l.created_by);
ALTER TABLE prospects FORCE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;
ALTER TABLE prospects ALTER COLUMN owner_user_id SET NOT NULL;
ALTER TABLE leads ALTER COLUMN owner_user_id SET NOT NULL;
CREATE INDEX prospects_organization_id_owner_user_id_idx ON prospects (organization_id, owner_user_id);
CREATE INDEX leads_organization_id_owner_user_id_idx ON leads (organization_id, owner_user_id);

-- El usuario (seller) tambien puede traer prospectos (los suyos).
CREATE OR REPLACE FUNCTION app_can_manage_prospects() RETURNS boolean LANGUAGE sql STABLE
AS $$ SELECT app_current_role() IN ('org_admin', 'sales_manager', 'campaign_manager', 'seller') $$;

CREATE FUNCTION app_owner_visible(p_owner uuid) RETURNS boolean LANGUAGE sql STABLE
AS $$ SELECT app_current_role() IS DISTINCT FROM 'seller' OR p_owner = app_current_user() $$;
CREATE FUNCTION owner_valid(p_org uuid, p_user uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = p_org AND m.user_id = p_user AND m.status = 'active'
                 AND m.role IN ('org_admin', 'sales_manager', 'campaign_manager', 'seller'))
$$;
GRANT EXECUTE ON FUNCTION app_owner_visible(uuid), owner_valid(uuid, uuid) TO app_runtime;

-- Propietario por defecto = quien crea; leads heredan el del prospecto. Solo org_admin puede cambiarlo, a un miembro activo.
CREATE FUNCTION owner_default_prospect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_user_id IS NULL THEN NEW.owner_user_id := NEW.created_by; END IF;
  IF NEW.owner_user_id <> NEW.created_by AND NOT app_is_org_admin() THEN
    RAISE EXCEPTION 'only an administrator can assign another owner' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION owner_default_lead() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_user_id IS NULL THEN
    SELECT p.owner_user_id INTO NEW.owner_user_id FROM prospects p WHERE p.id = NEW.prospect_id AND p.organization_id = NEW.organization_id;
    IF NEW.owner_user_id IS NULL THEN NEW.owner_user_id := NEW.created_by; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION owner_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    IF NOT app_is_org_admin() THEN RAISE EXCEPTION 'only an administrator can reassign the owner' USING ERRCODE = 'insufficient_privilege'; END IF;
    IF NOT owner_valid(NEW.organization_id, NEW.owner_user_id) THEN RAISE EXCEPTION 'the owner must be an active member of this organization' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prospects_owner_default BEFORE INSERT ON prospects FOR EACH ROW EXECUTE FUNCTION owner_default_prospect();
CREATE TRIGGER leads_owner_default BEFORE INSERT ON leads FOR EACH ROW EXECUTE FUNCTION owner_default_lead();
CREATE TRIGGER prospects_owner_change BEFORE UPDATE ON prospects FOR EACH ROW EXECUTE FUNCTION owner_change_guard();
CREATE TRIGGER leads_owner_change BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION owner_change_guard();

GRANT UPDATE (owner_user_id) ON prospects, leads TO app_runtime;

-- prospects
DROP POLICY prospects_select ON prospects;
DROP POLICY prospects_update ON prospects;
CREATE POLICY prospects_select ON prospects FOR SELECT TO app_runtime USING (organization_id = app_current_org() AND app_owner_visible(owner_user_id));
CREATE POLICY prospects_update ON prospects FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_can_manage_prospects() AND app_owner_visible(owner_user_id))
  WITH CHECK (organization_id = app_current_org() AND app_owner_visible(owner_user_id));
-- leads
DROP POLICY leads_select ON leads;
CREATE POLICY leads_select ON leads FOR SELECT TO app_runtime USING (organization_id = app_current_org() AND app_owner_visible(owner_user_id));
-- contactos: heredan del prospecto
DROP POLICY contacts_select ON contacts;
DROP POLICY contacts_insert ON contacts;
DROP POLICY contacts_update ON contacts;
CREATE POLICY contacts_select ON contacts FOR SELECT TO app_runtime
  USING (organization_id = app_current_org() AND EXISTS (SELECT 1 FROM prospects p WHERE p.id = prospect_id));
CREATE POLICY contacts_insert ON contacts FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_prospects() AND created_by = app_current_user() AND EXISTS (SELECT 1 FROM prospects p WHERE p.id = prospect_id));
CREATE POLICY contacts_update ON contacts FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_can_manage_prospects() AND EXISTS (SELECT 1 FROM prospects p WHERE p.id = prospect_id))
  WITH CHECK (organization_id = app_current_org());
-- borradores: heredan del contacto
DROP POLICY message_drafts_select ON message_drafts;
CREATE POLICY message_drafts_select ON message_drafts FOR SELECT TO app_runtime
  USING (organization_id = app_current_org() AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_id));

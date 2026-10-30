-- CreateTable
CREATE TABLE "routing_settings" (
    "organization_id" UUID NOT NULL,
    "strategy" TEXT NOT NULL,
    "first_response_sla_minutes" INTEGER,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "routing_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "seller_pool" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "max_open" INTEGER NOT NULL,
    "last_assigned_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_pool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'new',
    "owner_user_id" UUID,
    "assigned_at" TIMESTAMPTZ(6),
    "expected_value" DECIMAL(18,4),
    "currency" CHAR(3),
    "loss_reason" TEXT,
    "first_response_due_at" TIMESTAMPTZ(6),
    "first_contacted_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_stage_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "from_stage" TEXT,
    "to_stage" TEXT NOT NULL,
    "changed_by" UUID,
    "note" TEXT,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opportunity_stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opportunity_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "assigned_to" UUID,
    "assigned_by" UUID NOT NULL,
    "strategy" TEXT NOT NULL,
    "candidates" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opportunity_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "seller_pool_organization_id_user_id_key" ON "seller_pool"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "opportunities_organization_id_stage_idx" ON "opportunities"("organization_id", "stage");

-- CreateIndex
CREATE INDEX "opportunities_organization_id_owner_user_id_idx" ON "opportunities"("organization_id", "owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "opportunities_organization_id_id_key" ON "opportunities"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "opportunities_organization_id_lead_id_key" ON "opportunities"("organization_id", "lead_id");

-- CreateIndex
CREATE INDEX "opportunity_stage_history_organization_id_opportunity_id_ch_idx" ON "opportunity_stage_history"("organization_id", "opportunity_id", "changed_at");

-- CreateIndex
CREATE INDEX "opportunity_notes_organization_id_opportunity_id_created_at_idx" ON "opportunity_notes"("organization_id", "opportunity_id", "created_at");

-- CreateIndex
CREATE INDEX "opportunity_assignments_organization_id_opportunity_id_crea_idx" ON "opportunity_assignments"("organization_id", "opportunity_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "leads_organization_id_id_key" ON "leads"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "routing_settings" ADD CONSTRAINT "routing_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_pool" ADD CONSTRAINT "seller_pool_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_organization_id_lead_id_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_organization_id_prospect_id_fkey" FOREIGN KEY ("organization_id", "prospect_id") REFERENCES "prospects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_stage_history" ADD CONSTRAINT "opportunity_stage_history_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_stage_history" ADD CONSTRAINT "opportunity_stage_history_organization_id_opportunity_id_fkey" FOREIGN KEY ("organization_id", "opportunity_id") REFERENCES "opportunities"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_notes" ADD CONSTRAINT "opportunity_notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_notes" ADD CONSTRAINT "opportunity_notes_organization_id_opportunity_id_fkey" FOREIGN KEY ("organization_id", "opportunity_id") REFERENCES "opportunities"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_assignments" ADD CONSTRAINT "opportunity_assignments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_assignments" ADD CONSTRAINT "opportunity_assignments_organization_id_opportunity_id_fkey" FOREIGN KEY ("organization_id", "opportunity_id") REFERENCES "opportunities"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CRM (P9-01). Tenant RLS + seller visibility (a seller sees ONLY opportunities assigned to them) + valid stage machine + trigger-written history.
ALTER TABLE routing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_assignments ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION app_can_work_crm() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT app_current_role() IN ('org_admin', 'sales_manager', 'seller') $$;
CREATE FUNCTION app_can_manage_crm() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT app_current_role() IN ('org_admin', 'sales_manager') $$;
CREATE FUNCTION app_is_seller() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT app_current_role() = 'seller' $$;
GRANT EXECUTE ON FUNCTION app_can_work_crm(), app_can_manage_crm(), app_is_seller() TO app_runtime;

ALTER TABLE routing_settings
  ADD CONSTRAINT routing_strategy CHECK (strategy IN ('manual', 'round_robin')),
  ADD CONSTRAINT routing_sla CHECK (first_response_sla_minutes IS NULL OR first_response_sla_minutes BETWEEN 1 AND 10080);
ALTER TABLE seller_pool ADD CONSTRAINT seller_pool_capacity CHECK (max_open BETWEEN 1 AND 500);
ALTER TABLE opportunities
  ADD CONSTRAINT opportunities_stage CHECK (stage IN ('new', 'contacted', 'qualification', 'quote_requested', 'quote_sent', 'negotiation', 'won', 'lost', 'future')),
  ADD CONSTRAINT opportunities_title CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  ADD CONSTRAINT opportunities_currency CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT opportunities_value CHECK ((expected_value IS NULL) = (currency IS NULL) AND (expected_value IS NULL OR expected_value >= 0)),
  ADD CONSTRAINT opportunities_loss CHECK ((stage = 'lost') = (loss_reason IS NOT NULL)),
  ADD CONSTRAINT opportunities_closed CHECK ((stage IN ('won', 'lost')) = (closed_at IS NOT NULL));
ALTER TABLE opportunity_notes
  ADD CONSTRAINT opportunity_notes_kind CHECK (kind IN ('note', 'call', 'email', 'meeting')),
  ADD CONSTRAINT opportunity_notes_body CHECK (length(btrim(body)) BETWEEN 1 AND 2000);
ALTER TABLE opportunity_assignments ADD CONSTRAINT assignments_strategy CHECK (strategy IN ('manual', 'round_robin', 'queue'));

-- routing configuration and pool: managers only (sellers cannot even read the pool)
GRANT SELECT, INSERT ON routing_settings TO app_runtime;
GRANT UPDATE (strategy, first_response_sla_minutes, updated_by, updated_at) ON routing_settings TO app_runtime;
CREATE POLICY routing_select ON routing_settings FOR SELECT TO app_runtime USING (organization_id = app_current_org() AND NOT app_is_seller());
CREATE POLICY routing_insert ON routing_settings FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_can_manage_crm() AND updated_by = app_current_user());
CREATE POLICY routing_update ON routing_settings FOR UPDATE TO app_runtime USING (organization_id = app_current_org() AND app_can_manage_crm()) WITH CHECK (organization_id = app_current_org());

GRANT SELECT, INSERT, DELETE ON seller_pool TO app_runtime;
GRANT UPDATE (active, max_open, last_assigned_at, updated_at) ON seller_pool TO app_runtime;
CREATE POLICY pool_select ON seller_pool FOR SELECT TO app_runtime USING (organization_id = app_current_org() AND NOT app_is_seller());
CREATE POLICY pool_insert ON seller_pool FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_can_manage_crm() AND created_by = app_current_user());
CREATE POLICY pool_update ON seller_pool FOR UPDATE TO app_runtime USING (organization_id = app_current_org() AND app_can_manage_crm()) WITH CHECK (organization_id = app_current_org());
CREATE POLICY pool_delete ON seller_pool FOR DELETE TO app_runtime USING (organization_id = app_current_org() AND app_can_manage_crm());

-- opportunities: sellers see/update only their own, and can only move the stage
GRANT SELECT, INSERT ON opportunities TO app_runtime;
GRANT UPDATE (title, stage, owner_user_id, assigned_at, expected_value, currency, loss_reason, first_response_due_at, updated_at) ON opportunities TO app_runtime;
CREATE POLICY opportunities_select ON opportunities FOR SELECT TO app_runtime
  USING (organization_id = app_current_org() AND (NOT app_is_seller() OR owner_user_id = app_current_user()));
CREATE POLICY opportunities_insert ON opportunities FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_crm() AND created_by = app_current_user());
CREATE POLICY opportunities_update ON opportunities FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND ((app_can_manage_crm()) OR (app_is_seller() AND owner_user_id = app_current_user())))
  WITH CHECK (organization_id = app_current_org() AND (app_can_manage_crm() OR owner_user_id = app_current_user()));

CREATE FUNCTION crm_stage_allowed(p_from text, p_to text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_from
    WHEN 'new' THEN p_to IN ('contacted', 'lost', 'future')
    WHEN 'contacted' THEN p_to IN ('qualification', 'lost', 'future')
    WHEN 'qualification' THEN p_to IN ('quote_requested', 'quote_sent', 'negotiation', 'lost', 'future')
    WHEN 'quote_requested' THEN p_to IN ('quote_sent', 'lost', 'future')
    WHEN 'quote_sent' THEN p_to IN ('negotiation', 'won', 'lost', 'future')
    WHEN 'negotiation' THEN p_to IN ('quote_sent', 'won', 'lost', 'future')
    WHEN 'future' THEN p_to IN ('contacted', 'lost')
    ELSE false
  END
$$;
CREATE FUNCTION crm_valid_owner(p_org uuid, p_user uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = p_org AND m.user_id = p_user AND m.status = 'active' AND m.role IN ('org_admin', 'sales_manager', 'seller'))
$$;
GRANT EXECUTE ON FUNCTION crm_stage_allowed(text, text), crm_valid_owner(uuid, uuid) TO app_runtime;

CREATE FUNCTION opportunities_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l leads%ROWTYPE; p prospects%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO l FROM leads WHERE id = NEW.lead_id AND organization_id = NEW.organization_id;
    IF NOT FOUND OR l.state <> 'accepted' THEN RAISE EXCEPTION 'an opportunity needs an accepted lead' USING ERRCODE = 'check_violation'; END IF;
    IF l.prospect_id <> NEW.prospect_id THEN RAISE EXCEPTION 'prospect does not match the lead' USING ERRCODE = 'check_violation'; END IF;
    SELECT * INTO p FROM prospects WHERE id = NEW.prospect_id AND organization_id = NEW.organization_id;
    IF EXISTS (SELECT 1 FROM suppressions s WHERE s.organization_id = p.organization_id AND ((s.kind = 'domain' AND s.value_key = p.domain_key) OR (s.kind = 'name' AND s.value_key = p.name_key))) THEN
      RAISE EXCEPTION 'a suppressed prospect cannot become an opportunity' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.stage <> 'new' THEN RAISE EXCEPTION 'opportunities start in stage new' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.owner_user_id IS NOT NULL AND NOT crm_valid_owner(NEW.organization_id, NEW.owner_user_id) THEN RAISE EXCEPTION 'the owner must be an active seller, sales manager or admin' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NOT app_can_manage_crm() AND (NEW.title, NEW.owner_user_id, NEW.assigned_at, NEW.expected_value, NEW.currency, NEW.first_response_due_at)
       IS DISTINCT FROM (OLD.title, OLD.owner_user_id, OLD.assigned_at, OLD.expected_value, OLD.currency, OLD.first_response_due_at) THEN
    RAISE EXCEPTION 'sellers can only change the stage of their opportunities' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id AND NEW.owner_user_id IS NOT NULL AND NOT crm_valid_owner(NEW.organization_id, NEW.owner_user_id) THEN
    RAISE EXCEPTION 'the owner must be an active seller, sales manager or admin' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    IF NOT crm_stage_allowed(OLD.stage, NEW.stage) THEN RAISE EXCEPTION 'invalid stage transition % -> %', OLD.stage, NEW.stage USING ERRCODE = 'check_violation'; END IF;
    IF NEW.stage = 'contacted' AND NEW.first_contacted_at IS NULL THEN NEW.first_contacted_at := now(); END IF;
    IF NEW.stage IN ('won', 'lost') THEN NEW.closed_at := now(); END IF;
  ELSIF OLD.stage IN ('won', 'lost') AND (NEW.title, NEW.owner_user_id, NEW.loss_reason, NEW.expected_value) IS DISTINCT FROM (OLD.title, OLD.owner_user_id, OLD.loss_reason, OLD.expected_value) THEN
    RAISE EXCEPTION 'closed opportunities are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opportunities_guard BEFORE INSERT OR UPDATE ON opportunities FOR EACH ROW EXECUTE FUNCTION opportunities_guard();

-- history is written by the database itself on every stage change (note comes from the transaction-local setting app.stage_note)
CREATE FUNCTION opportunities_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.stage IS DISTINCT FROM OLD.stage THEN
    INSERT INTO public.opportunity_stage_history (id, organization_id, opportunity_id, from_stage, to_stage, changed_by, note)
    VALUES (gen_random_uuid(), NEW.organization_id, NEW.id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.stage END, NEW.stage,
            NULLIF(current_setting('app.user_id', true), '')::uuid, NULLIF(left(current_setting('app.stage_note', true), 300), ''));
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION opportunities_history() FROM PUBLIC;
CREATE TRIGGER opportunities_history AFTER INSERT OR UPDATE ON opportunities FOR EACH ROW EXECUTE FUNCTION opportunities_history();

GRANT SELECT ON opportunity_stage_history TO app_runtime;
CREATE POLICY history_select ON opportunity_stage_history FOR SELECT TO app_runtime
  USING (organization_id = app_current_org() AND EXISTS (SELECT 1 FROM opportunities o WHERE o.id = opportunity_id AND o.organization_id = organization_id));

GRANT SELECT, INSERT ON opportunity_notes TO app_runtime;
CREATE POLICY notes_select ON opportunity_notes FOR SELECT TO app_runtime
  USING (organization_id = app_current_org() AND EXISTS (SELECT 1 FROM opportunities o WHERE o.id = opportunity_id AND o.organization_id = organization_id));
CREATE POLICY notes_insert ON opportunity_notes FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_work_crm() AND created_by = app_current_user()
              AND EXISTS (SELECT 1 FROM opportunities o WHERE o.id = opportunity_id AND o.organization_id = organization_id));

GRANT SELECT, INSERT ON opportunity_assignments TO app_runtime;
CREATE POLICY assignments_select ON opportunity_assignments FOR SELECT TO app_runtime
  USING (organization_id = app_current_org() AND EXISTS (SELECT 1 FROM opportunities o WHERE o.id = opportunity_id AND o.organization_id = organization_id));
CREATE POLICY assignments_insert ON opportunity_assignments FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_crm() AND assigned_by = app_current_user());

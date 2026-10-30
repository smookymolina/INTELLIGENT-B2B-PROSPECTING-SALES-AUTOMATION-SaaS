-- CreateTable
CREATE TABLE "quote_settings" (
    "organization_id" UUID NOT NULL,
    "max_discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "quote_counters" (
    "organization_id" UUID NOT NULL,
    "last_number" INTEGER NOT NULL,

    CONSTRAINT "quote_counters_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "price_list_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "valid_until" DATE,
    "tax_rate" DECIMAL(7,4),
    "notes" TEXT,
    "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "discount_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "discount_approved_by" UUID,
    "discount_approved_at" TIMESTAMPTZ(6),
    "lines_hash" TEXT,
    "sent_by" UUID,
    "sent_at" TIMESTAMPTZ(6),
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "item_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "item_version" INTEGER NOT NULL,
    "unit" TEXT,
    "item_ref" TEXT NOT NULL,
    "price_ref" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "gross" DECIMAL(18,4) NOT NULL,
    "discount_amount" DECIMAL(18,4) NOT NULL,
    "line_total" DECIMAL(18,4) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "total" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "closed_by" UUID NOT NULL,
    "closed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quotes_organization_id_opportunity_id_idx" ON "quotes"("organization_id", "opportunity_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_organization_id_id_key" ON "quotes"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_organization_id_number_key" ON "quotes"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "quote_lines_quote_id_position_key" ON "quote_lines"("quote_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "quote_lines_quote_id_item_id_key" ON "quote_lines"("quote_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_organization_id_quote_id_key" ON "sales"("organization_id", "quote_id");

-- AddForeignKey
ALTER TABLE "quote_settings" ADD CONSTRAINT "quote_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_counters" ADD CONSTRAINT "quote_counters_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_organization_id_opportunity_id_fkey" FOREIGN KEY ("organization_id", "opportunity_id") REFERENCES "opportunities"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_organization_id_price_list_id_fkey" FOREIGN KEY ("organization_id", "price_list_id") REFERENCES "price_lists"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_organization_id_quote_id_fkey" FOREIGN KEY ("organization_id", "quote_id") REFERENCES "quotes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_organization_id_item_id_fkey" FOREIGN KEY ("organization_id", "item_id") REFERENCES "catalog_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_organization_id_quote_id_fkey" FOREIGN KEY ("organization_id", "quote_id") REFERENCES "quotes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Quotes (P10-01). Tenant RLS (visibility follows the opportunity, so a seller sees only their own quotes), lines only from APPROVED evidence,
-- exact decimal arithmetic cross-checked by the database, discount approval, and a frozen snapshot once sent.
ALTER TABLE quote_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION app_can_manage_quotes() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT app_current_role() IN ('org_admin', 'sales_manager', 'seller') $$;
CREATE FUNCTION quote_max_discount(p_org uuid) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT coalesce((SELECT max_discount_percent FROM quote_settings WHERE organization_id = p_org), 0) $$;
CREATE FUNCTION quote_lines_hash(p_quote uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(md5(string_agg(item_id::text || ':' || quantity::text || ':' || unit_price::text || ':' || discount_percent::text, '|' ORDER BY position)), '') FROM quote_lines WHERE quote_id = p_quote
$$;
GRANT EXECUTE ON FUNCTION app_can_manage_quotes(), quote_max_discount(uuid), quote_lines_hash(uuid) TO app_runtime;

ALTER TABLE quote_settings ADD CONSTRAINT quote_settings_range CHECK (max_discount_percent BETWEEN 0 AND 100);
ALTER TABLE quotes
  ADD CONSTRAINT quotes_status CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'cancelled')),
  ADD CONSTRAINT quotes_currency CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT quotes_tax_range CHECK (tax_rate IS NULL OR tax_rate BETWEEN 0 AND 100),
  ADD CONSTRAINT quotes_total_consistent CHECK (total = subtotal - discount_total + tax_total AND subtotal >= 0 AND discount_total >= 0 AND tax_total >= 0),
  ADD CONSTRAINT quotes_number_pos CHECK (number > 0);
ALTER TABLE quote_lines
  ADD CONSTRAINT quote_lines_qty CHECK (quantity > 0),
  ADD CONSTRAINT quote_lines_price CHECK (unit_price >= 0),
  ADD CONSTRAINT quote_lines_discount CHECK (discount_percent BETWEEN 0 AND 100),
  ADD CONSTRAINT quote_lines_gross CHECK (gross = round(quantity * unit_price, 4)),
  ADD CONSTRAINT quote_lines_discount_amount CHECK (discount_amount = round(gross * discount_percent / 100, 4)),
  ADD CONSTRAINT quote_lines_total CHECK (line_total = gross - discount_amount),
  ADD CONSTRAINT quote_lines_refs CHECK (item_ref = 'item:' || item_id::text || ':v' || item_version::text AND price_ref ~ '^price:[0-9a-f-]{36}$');

-- settings: any quote reader may read, only org_admin writes
GRANT SELECT, INSERT ON quote_settings TO app_runtime;
GRANT UPDATE (max_discount_percent, updated_by, updated_at) ON quote_settings TO app_runtime;
CREATE POLICY quote_settings_select ON quote_settings FOR SELECT TO app_runtime USING (organization_id = app_current_org());
CREATE POLICY quote_settings_insert ON quote_settings FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_is_org_admin() AND updated_by = app_current_user());
CREATE POLICY quote_settings_update ON quote_settings FOR UPDATE TO app_runtime USING (organization_id = app_current_org() AND app_is_org_admin()) WITH CHECK (organization_id = app_current_org());

GRANT SELECT, INSERT ON quote_counters TO app_runtime;
GRANT UPDATE (last_number) ON quote_counters TO app_runtime;
CREATE POLICY quote_counters_select ON quote_counters FOR SELECT TO app_runtime USING (organization_id = app_current_org() AND app_can_manage_quotes());
CREATE POLICY quote_counters_insert ON quote_counters FOR INSERT TO app_runtime WITH CHECK (organization_id = app_current_org() AND app_can_manage_quotes());
CREATE POLICY quote_counters_update ON quote_counters FOR UPDATE TO app_runtime USING (organization_id = app_current_org() AND app_can_manage_quotes()) WITH CHECK (organization_id = app_current_org());

-- quotes: visible only through a visible opportunity (sellers: their own)
GRANT SELECT, INSERT ON quotes TO app_runtime;
GRANT UPDATE (status, valid_until, tax_rate, notes, subtotal, discount_total, tax_total, total, discount_approved_by, discount_approved_at, lines_hash, sent_by, sent_at, decided_by, decided_at, decision_note, updated_at) ON quotes TO app_runtime;
CREATE POLICY quotes_select ON quotes FOR SELECT TO app_runtime
  USING (organization_id = app_current_org() AND EXISTS (SELECT 1 FROM opportunities o WHERE o.id = quotes.opportunity_id));
CREATE POLICY quotes_insert ON quotes FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_quotes() AND created_by = app_current_user() AND status = 'draft'
              AND EXISTS (SELECT 1 FROM opportunities o WHERE o.id = quotes.opportunity_id));
CREATE POLICY quotes_update ON quotes FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_can_manage_quotes() AND EXISTS (SELECT 1 FROM opportunities o WHERE o.id = quotes.opportunity_id))
  WITH CHECK (organization_id = app_current_org());

CREATE FUNCTION quotes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pl price_lists%ROWTYPE; st text; s numeric; d numeric; tax numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO pl FROM price_lists WHERE id = NEW.price_list_id AND organization_id = NEW.organization_id;
    IF NOT FOUND OR pl.status <> 'approved' THEN RAISE EXCEPTION 'quotes need an approved price list' USING ERRCODE = 'check_violation'; END IF;
    IF pl.currency <> NEW.currency THEN RAISE EXCEPTION 'the quote currency must match the price list' USING ERRCODE = 'check_violation'; END IF;
    SELECT stage INTO st FROM opportunities WHERE id = NEW.opportunity_id AND organization_id = NEW.organization_id;
    IF NOT FOUND OR st IN ('won', 'lost') THEN RAISE EXCEPTION 'quotes need an open opportunity' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'draft' THEN
    IF OLD.status = 'sent' AND NEW.status IN ('accepted', 'rejected', 'cancelled')
       AND (NEW.opportunity_id, NEW.number, NEW.price_list_id, NEW.currency, NEW.valid_until, NEW.tax_rate, NEW.notes, NEW.subtotal, NEW.discount_total, NEW.tax_total, NEW.total, NEW.sent_at)
           IS NOT DISTINCT FROM (OLD.opportunity_id, OLD.number, OLD.price_list_id, OLD.currency, OLD.valid_until, OLD.tax_rate, OLD.notes, OLD.subtotal, OLD.discount_total, OLD.tax_total, OLD.total, OLD.sent_at) THEN
      IF NEW.status = 'accepted' AND NEW.valid_until IS NOT NULL AND NEW.valid_until < current_date THEN
        RAISE EXCEPTION 'the quote has expired' USING ERRCODE = 'check_violation';
      END IF;
      NEW.decided_by := app_current_user();
      NEW.decided_at := now();
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'sent quotes are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.status NOT IN ('draft', 'sent', 'cancelled') THEN RAISE EXCEPTION 'invalid quote transition' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.discount_approved_by IS NOT NULL AND (NEW.discount_approved_by, NEW.discount_approved_at, NEW.lines_hash) IS DISTINCT FROM (OLD.discount_approved_by, OLD.discount_approved_at, OLD.lines_hash)
     AND NOT app_is_org_admin() THEN
    RAISE EXCEPTION 'only org_admin can approve discounts' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.status = 'sent' THEN
    IF NOT EXISTS (SELECT 1 FROM quote_lines WHERE quote_id = NEW.id) THEN RAISE EXCEPTION 'a quote needs at least one line' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.valid_until IS NOT NULL AND NEW.valid_until < current_date THEN RAISE EXCEPTION 'the validity date has already passed' USING ERRCODE = 'check_violation'; END IF;
    IF NOT EXISTS (SELECT 1 FROM price_lists WHERE id = NEW.price_list_id AND organization_id = NEW.organization_id AND status = 'approved') THEN
      RAISE EXCEPTION 'the price list is no longer approved' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM quote_lines l
      LEFT JOIN catalog_items i ON i.id = l.item_id
      LEFT JOIN price_list_entries e ON e.id = substring(l.price_ref from 7)::uuid AND e.price_list_id = NEW.price_list_id AND e.item_id = l.item_id AND e.unit_price = l.unit_price
      WHERE l.quote_id = NEW.id AND (i.approved_version IS DISTINCT FROM l.item_version OR i.archived_at IS NOT NULL OR e.id IS NULL)
    ) THEN
      RAISE EXCEPTION 'a line is no longer backed by approved evidence' USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(gross), 0), coalesce(sum(discount_amount), 0) INTO s, d FROM quote_lines WHERE quote_id = NEW.id;
    tax := CASE WHEN NEW.tax_rate IS NULL THEN 0 ELSE round((s - d) * NEW.tax_rate / 100, 4) END;
    IF (NEW.subtotal, NEW.discount_total, NEW.tax_total, NEW.total) IS DISTINCT FROM (s, d, tax, s - d + tax) THEN
      RAISE EXCEPTION 'the totals do not match the lines' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM quote_lines WHERE quote_id = NEW.id AND discount_percent > quote_max_discount(NEW.organization_id)) THEN
      IF NEW.discount_approved_by IS NULL OR NEW.lines_hash IS DISTINCT FROM quote_lines_hash(NEW.id) THEN
        RAISE EXCEPTION 'a discount above the limit needs a current approval' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    NEW.sent_by := app_current_user();
    NEW.sent_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quotes_guard BEFORE INSERT OR UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION quotes_guard();

-- lines
GRANT SELECT, INSERT, DELETE ON quote_lines TO app_runtime;
GRANT UPDATE (quantity, discount_percent, gross, discount_amount, line_total) ON quote_lines TO app_runtime;
CREATE POLICY quote_lines_select ON quote_lines FOR SELECT TO app_runtime
  USING (organization_id = app_current_org() AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_lines.quote_id));
CREATE POLICY quote_lines_insert ON quote_lines FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_quotes() AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_lines.quote_id));
CREATE POLICY quote_lines_update ON quote_lines FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_can_manage_quotes() AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_lines.quote_id)) WITH CHECK (organization_id = app_current_org());
CREATE POLICY quote_lines_delete ON quote_lines FOR DELETE TO app_runtime
  USING (organization_id = app_current_org() AND app_can_manage_quotes() AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_lines.quote_id));

CREATE FUNCTION quote_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q quotes%ROWTYPE; ep numeric; ia int; iarch timestamptz;
BEGIN
  SELECT * INTO q FROM quotes WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.quote_id ELSE NEW.quote_id END FOR SHARE;
  IF NOT FOUND OR q.status <> 'draft' THEN RAISE EXCEPTION 'lines can only change while the quote is a draft' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT e.unit_price INTO ep FROM price_list_entries e JOIN price_lists l ON l.id = e.price_list_id
     WHERE e.id = substring(NEW.price_ref from 7)::uuid AND e.price_list_id = q.price_list_id AND e.item_id = NEW.item_id AND l.status = 'approved';
    IF NOT FOUND OR ep <> NEW.unit_price THEN RAISE EXCEPTION 'the price must come from an approved price list entry' USING ERRCODE = 'check_violation'; END IF;
    SELECT approved_version, archived_at INTO ia, iarch FROM catalog_items WHERE id = NEW.item_id;
    IF ia IS DISTINCT FROM NEW.item_version OR iarch IS NOT NULL THEN RAISE EXCEPTION 'the item must be approved and not archived' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER quote_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON quote_lines FOR EACH ROW EXECUTE FUNCTION quote_lines_guard();

-- any change to the lines withdraws a previous discount approval (it was granted for those exact lines)
CREATE FUNCTION quote_lines_reset_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE quotes SET discount_approved_by = NULL, discount_approved_at = NULL, lines_hash = NULL
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.quote_id ELSE NEW.quote_id END AND discount_approved_by IS NOT NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER quote_lines_reset_approval AFTER INSERT OR UPDATE OR DELETE ON quote_lines FOR EACH ROW EXECUTE FUNCTION quote_lines_reset_approval();

-- sales: immutable, only for an accepted quote with matching totals
GRANT SELECT, INSERT ON sales TO app_runtime;
CREATE POLICY sales_select ON sales FOR SELECT TO app_runtime
  USING (organization_id = app_current_org() AND EXISTS (SELECT 1 FROM opportunities o WHERE o.id = sales.opportunity_id));
CREATE POLICY sales_insert ON sales FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_manage_quotes() AND closed_by = app_current_user());
CREATE FUNCTION sales_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q quotes%ROWTYPE; o opportunities%ROWTYPE;
BEGIN
  SELECT * INTO q FROM quotes WHERE id = NEW.quote_id AND organization_id = NEW.organization_id;
  IF NOT FOUND OR q.status <> 'accepted' THEN RAISE EXCEPTION 'a sale needs an accepted quote' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO o FROM opportunities WHERE id = q.opportunity_id AND organization_id = q.organization_id;
  IF NEW.opportunity_id <> q.opportunity_id OR NEW.total <> q.total OR NEW.currency <> q.currency OR NEW.lead_id <> o.lead_id OR NEW.prospect_id <> o.prospect_id THEN
    RAISE EXCEPTION 'the sale does not match its quote' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_guard BEFORE INSERT ON sales FOR EACH ROW EXECUTE FUNCTION sales_guard();

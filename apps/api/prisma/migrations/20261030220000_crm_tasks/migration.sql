-- CreateTable
CREATE TABLE "opportunity_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "assignee_user_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_by" UUID,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "opportunity_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "opportunity_tasks_organization_id_state_due_at_idx" ON "opportunity_tasks"("organization_id", "state", "due_at");

-- CreateIndex
CREATE INDEX "opportunity_tasks_organization_id_assignee_user_id_state_idx" ON "opportunity_tasks"("organization_id", "assignee_user_id", "state");

-- CreateIndex
CREATE INDEX "opportunity_tasks_organization_id_opportunity_id_idx" ON "opportunity_tasks"("organization_id", "opportunity_id");

-- AddForeignKey
ALTER TABLE "opportunity_tasks" ADD CONSTRAINT "opportunity_tasks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_tasks" ADD CONSTRAINT "opportunity_tasks_organization_id_opportunity_id_fkey" FOREIGN KEY ("organization_id", "opportunity_id") REFERENCES "opportunities"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Row-level security: tasks follow the visibility of their opportunity (sellers only see/work tasks of opportunities assigned to them).
ALTER TABLE opportunity_tasks ADD CONSTRAINT task_state CHECK (state IN ('open', 'done', 'cancelled'));
ALTER TABLE opportunity_tasks ADD CONSTRAINT task_title CHECK (char_length(btrim(title)) BETWEEN 1 AND 200);
ALTER TABLE opportunity_tasks ADD CONSTRAINT task_completion CHECK ((state = 'open') = (completed_at IS NULL AND completed_by IS NULL));
ALTER TABLE opportunity_tasks ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON opportunity_tasks TO app_runtime;
GRANT UPDATE (state, completed_by, completed_at) ON opportunity_tasks TO app_runtime;
CREATE POLICY tasks_select ON opportunity_tasks FOR SELECT TO app_runtime
  USING (organization_id = app_current_org() AND EXISTS (SELECT 1 FROM opportunities o WHERE o.id = opportunity_tasks.opportunity_id AND o.organization_id = opportunity_tasks.organization_id));
CREATE POLICY tasks_insert ON opportunity_tasks FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app_current_org() AND app_can_work_crm() AND created_by = app_current_user()
              AND (app_can_manage_crm() OR assignee_user_id = app_current_user())
              AND EXISTS (SELECT 1 FROM opportunities o WHERE o.id = opportunity_tasks.opportunity_id AND o.organization_id = opportunity_tasks.organization_id));
CREATE POLICY tasks_update ON opportunity_tasks FOR UPDATE TO app_runtime
  USING (organization_id = app_current_org() AND app_can_work_crm()
         AND EXISTS (SELECT 1 FROM opportunities o WHERE o.id = opportunity_tasks.opportunity_id AND o.organization_id = opportunity_tasks.organization_id))
  WITH CHECK (organization_id = app_current_org());

CREATE FUNCTION opportunity_tasks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o opportunities%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'open' THEN RAISE EXCEPTION 'a task starts open' USING ERRCODE = 'check_violation'; END IF;
    SELECT * INTO o FROM opportunities WHERE id = NEW.opportunity_id AND organization_id = NEW.organization_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'opportunity not found' USING ERRCODE = 'check_violation'; END IF;
    IF o.stage IN ('won', 'lost') THEN RAISE EXCEPTION 'tasks cannot be added to a closed opportunity' USING ERRCODE = 'check_violation'; END IF;
    IF NOT crm_valid_owner(NEW.organization_id, NEW.assignee_user_id) THEN RAISE EXCEPTION 'the assignee must be an active seller, sales manager or admin' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state <> 'open' THEN RAISE EXCEPTION 'a closed task cannot change' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.state NOT IN ('done', 'cancelled') THEN RAISE EXCEPTION 'a task can only be completed or cancelled' USING ERRCODE = 'check_violation'; END IF;
  NEW.completed_at := now();
  NEW.completed_by := app_current_user();
  RETURN NEW;
END $$;
CREATE TRIGGER opportunity_tasks_guard BEFORE INSERT OR UPDATE ON opportunity_tasks FOR EACH ROW EXECUTE FUNCTION opportunity_tasks_guard();

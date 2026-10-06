-- 002_rls.sql — Row-Level Security (spec §32, §36). Defence in depth: the API also authorizes.
-- Request context is set per transaction:  set_config('app.user_id', <uuid>, true)
-- System jobs (cron, auth bootstrap) set:  set_config('app.system', 'on', true)
-- baby_membership and household_member are the authority tables and are read via SECURITY DEFINER
-- helpers; they are not FORCE-RLS protected and are only accessed through the authz layer.

CREATE OR REPLACE FUNCTION app_uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.system', true), '') = 'on' $$;

-- Membership-only lookup (no join to the FORCE-RLS baby table, which would recurse).
CREATE OR REPLACE FUNCTION app_baby_role(b uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT m.role FROM baby_membership m
   WHERE m.baby_id = b AND m.user_id = app_uid() AND m.revoked_at IS NULL $$;

CREATE OR REPLACE FUNCTION app_can_read(b uuid) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app_is_system() OR app_baby_role(b) IS NOT NULL $$;

-- levels: LOG (feeds, measurements, doses), MANAGE (clinical records), OWNER
CREATE OR REPLACE FUNCTION app_can_write(b uuid, lvl text) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app_is_system() OR CASE lvl
     WHEN 'LOG'    THEN app_baby_role(b) IN ('OWNER','GUARDIAN','CAREGIVER')
     WHEN 'MANAGE' THEN app_baby_role(b) IN ('OWNER','GUARDIAN')
     WHEN 'OWNER'  THEN app_baby_role(b) = 'OWNER'
     ELSE false END $$;

CREATE OR REPLACE FUNCTION app_can_docs(b uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT app_is_system() OR EXISTS (SELECT 1 FROM baby_membership m WHERE m.baby_id = b AND m.user_id = app_uid()
     AND m.revoked_at IS NULL AND (m.can_view_documents OR m.role IN ('OWNER','GUARDIAN'))) $$;

-- small non-RLS index table so household checks don't need to read the RLS-protected baby table
CREATE TABLE baby_household_index (baby_id uuid PRIMARY KEY REFERENCES baby(id), household_id uuid NOT NULL REFERENCES household(id));
CREATE OR REPLACE FUNCTION trg_baby_household_index() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO baby_household_index(baby_id, household_id) VALUES (NEW.id, NEW.household_id)
  ON CONFLICT (baby_id) DO UPDATE SET household_id = EXCLUDED.household_id;
  RETURN NEW;
END $$;
CREATE TRIGGER baby_household_index_sync AFTER INSERT OR UPDATE OF household_id ON baby
  FOR EACH ROW EXECUTE FUNCTION trg_baby_household_index();

CREATE OR REPLACE FUNCTION app_in_household(h uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT app_is_system() OR EXISTS (SELECT 1 FROM household_member hm WHERE hm.household_id = h AND hm.user_id = app_uid() AND hm.left_at IS NULL)
   OR EXISTS (SELECT 1 FROM baby_membership m JOIN baby_household_index bi ON bi.baby_id = m.baby_id
              WHERE bi.household_id = h AND m.user_id = app_uid() AND m.revoked_at IS NULL) $$;


-- ---------- baby ----------
ALTER TABLE baby ENABLE ROW LEVEL SECURITY; ALTER TABLE baby FORCE ROW LEVEL SECURITY;
CREATE POLICY baby_select ON baby FOR SELECT USING (app_can_read(id));
CREATE POLICY baby_insert ON baby FOR INSERT WITH CHECK (app_is_system() OR (created_by = app_uid() AND app_in_household(household_id)));
CREATE POLICY baby_update ON baby FOR UPDATE USING (app_can_write(id, 'MANAGE')) WITH CHECK (app_can_write(id, 'MANAGE'));

ALTER TABLE baby_profile ENABLE ROW LEVEL SECURITY; ALTER TABLE baby_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY bp_select ON baby_profile FOR SELECT USING (app_can_read(baby_id));
CREATE POLICY bp_insert ON baby_profile FOR INSERT WITH CHECK (app_can_write(baby_id, 'MANAGE'));
CREATE POLICY bp_update ON baby_profile FOR UPDATE USING (app_can_write(baby_id, 'MANAGE')) WITH CHECK (app_can_write(baby_id, 'MANAGE'));

-- ---------- generic baby-scoped PHI tables ----------
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
      ('feeding','LOG'), ('weight_measurement','LOG'), ('medicine_dose','LOG'),
      ('feeding_plan','MANAGE'), ('appointment','MANAGE'), ('vaccination','MANAGE'), ('prescription','MANAGE'),
      ('prescription_item','MANAGE'), ('medicine','MANAGE'), ('medicine_schedule','MANAGE'), ('allergy','MANAGE'),
      ('baby_schedule_selection','MANAGE'), ('custom_event','LOG'), ('share_link','MANAGE')
  ) AS v(tbl, lvl) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (app_can_read(baby_id))', t.tbl || '_select', t.tbl);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_can_write(baby_id, %L))', t.tbl || '_insert', t.tbl, t.lvl);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_can_write(baby_id, %L)) WITH CHECK (app_can_write(baby_id, %L))', t.tbl || '_update', t.tbl, t.lvl, t.lvl);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (app_is_system() OR app_can_write(baby_id, %L))', t.tbl || '_delete', t.tbl, t.lvl);
  END LOOP;
END $$;

-- timeline: readable by members; written alongside source rows by anyone who may LOG
ALTER TABLE timeline_event ENABLE ROW LEVEL SECURITY; ALTER TABLE timeline_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tl_select ON timeline_event FOR SELECT USING (app_can_read(baby_id));
CREATE POLICY tl_insert ON timeline_event FOR INSERT WITH CHECK (app_can_write(baby_id, 'LOG'));
CREATE POLICY tl_update ON timeline_event FOR UPDATE USING (app_can_write(baby_id, 'LOG')) WITH CHECK (app_can_read(baby_id));
CREATE POLICY tl_delete ON timeline_event FOR DELETE USING (app_is_system());

-- documents: read requires document permission
ALTER TABLE medical_document ENABLE ROW LEVEL SECURITY; ALTER TABLE medical_document FORCE ROW LEVEL SECURITY;
CREATE POLICY doc_select ON medical_document FOR SELECT USING (app_can_docs(baby_id));
CREATE POLICY doc_insert ON medical_document FOR INSERT WITH CHECK (app_can_write(baby_id, 'MANAGE'));
CREATE POLICY doc_update ON medical_document FOR UPDATE USING (app_can_write(baby_id, 'MANAGE')) WITH CHECK (app_can_write(baby_id, 'MANAGE'));
CREATE POLICY doc_delete ON medical_document FOR DELETE USING (app_is_system());

-- export jobs: requester + must be able to read the baby
ALTER TABLE export_job ENABLE ROW LEVEL SECURITY; ALTER TABLE export_job FORCE ROW LEVEL SECURITY;
CREATE POLICY exp_all ON export_job USING (app_is_system() OR (requested_by = app_uid() AND app_can_read(baby_id)))
  WITH CHECK (app_is_system() OR (requested_by = app_uid() AND app_can_write(baby_id, 'MANAGE')));

-- ---------- household-scoped directory ----------
ALTER TABLE doctor ENABLE ROW LEVEL SECURITY; ALTER TABLE doctor FORCE ROW LEVEL SECURITY;
CREATE POLICY doctor_all ON doctor USING (app_in_household(household_id)) WITH CHECK (app_in_household(household_id));
ALTER TABLE clinic ENABLE ROW LEVEL SECURITY; ALTER TABLE clinic FORCE ROW LEVEL SECURITY;
CREATE POLICY clinic_all ON clinic USING (app_in_household(household_id)) WITH CHECK (app_in_household(household_id));

-- ---------- user-owned ----------
ALTER TABLE notification ENABLE ROW LEVEL SECURITY; ALTER TABLE notification FORCE ROW LEVEL SECURITY;
CREATE POLICY notif_all ON notification USING (app_is_system() OR user_id = app_uid()) WITH CHECK (app_is_system() OR user_id = app_uid());
ALTER TABLE push_subscription ENABLE ROW LEVEL SECURITY; ALTER TABLE push_subscription FORCE ROW LEVEL SECURITY;
CREATE POLICY push_all ON push_subscription USING (app_is_system() OR user_id = app_uid()) WITH CHECK (app_is_system() OR user_id = app_uid());
ALTER TABLE consent_record ENABLE ROW LEVEL SECURITY; ALTER TABLE consent_record FORCE ROW LEVEL SECURITY;
CREATE POLICY consent_select ON consent_record FOR SELECT USING (app_is_system() OR user_id = app_uid());
CREATE POLICY consent_insert ON consent_record FOR INSERT WITH CHECK (app_is_system() OR user_id = app_uid());
ALTER TABLE user_session ENABLE ROW LEVEL SECURITY; ALTER TABLE user_session FORCE ROW LEVEL SECURITY;
CREATE POLICY session_all ON user_session USING (app_is_system() OR user_id = app_uid()) WITH CHECK (app_is_system() OR user_id = app_uid());
ALTER TABLE idempotency_key ENABLE ROW LEVEL SECURITY; ALTER TABLE idempotency_key FORCE ROW LEVEL SECURITY;
CREATE POLICY idem_all ON idempotency_key USING (app_is_system() OR user_id = app_uid()) WITH CHECK (app_is_system() OR user_id = app_uid());

-- ---------- audit: append-only ----------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (app_is_system() OR actor_user_id = app_uid());
CREATE POLICY audit_select ON audit_log FOR SELECT USING (app_is_system() OR actor_user_id = app_uid() OR (baby_id IS NOT NULL AND app_baby_role(baby_id) = 'OWNER'));
-- no UPDATE / DELETE policies => denied for everyone, including the table owner (FORCE).
CREATE OR REPLACE FUNCTION trg_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION trg_audit_immutable();

-- 004: allow any member who can read a baby to create their own PDF export (data exports are still MANAGE-gated in the API).
DROP POLICY IF EXISTS exp_all ON export_job;
CREATE POLICY exp_all ON export_job USING (app_is_system() OR (requested_by = app_uid() AND app_can_read(baby_id)))
  WITH CHECK (app_is_system() OR (requested_by = app_uid() AND app_can_read(baby_id)));

-- 005: allow system-context purge jobs to hard-delete babies and profiles (spec §36 Deletion).
CREATE POLICY baby_delete ON baby FOR DELETE USING (app_is_system());
CREATE POLICY bp_delete ON baby_profile FOR DELETE USING (app_is_system());

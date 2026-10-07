-- 007: excretions (pee / poop / both / vomit) with a free-text note. Counts only — no thresholds or alerts (spec §197).
CREATE TABLE excretion (
  id uuid PRIMARY KEY,
  baby_id uuid NOT NULL REFERENCES baby(id),
  occurred_at timestamptz NOT NULL,
  occurred_tz text NOT NULL,
  local_date date NOT NULL,
  excretion_type text NOT NULL CHECK (excretion_type IN ('URINE','STOOL','URINE_AND_STOOL','VOMIT')),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  client_id text,
  moved_from_baby_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deleted_by uuid, version int NOT NULL DEFAULT 1,
  UNIQUE (baby_id, client_id),
  UNIQUE (id, baby_id)
);
CREATE INDEX ix_excretion_baby_day ON excretion(baby_id, local_date) WHERE deleted_at IS NULL;
CREATE INDEX ix_excretion_baby_time ON excretion(baby_id, occurred_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE excretion ENABLE ROW LEVEL SECURITY; ALTER TABLE excretion FORCE ROW LEVEL SECURITY;
CREATE POLICY excretion_select ON excretion FOR SELECT USING (app_can_read(baby_id));
CREATE POLICY excretion_insert ON excretion FOR INSERT WITH CHECK (app_can_write(baby_id, 'LOG'));
CREATE POLICY excretion_update ON excretion FOR UPDATE USING (app_can_write(baby_id, 'LOG')) WITH CHECK (app_can_write(baby_id, 'LOG'));
CREATE POLICY excretion_delete ON excretion FOR DELETE USING (app_is_system() OR app_can_write(baby_id, 'LOG'));

ALTER TABLE timeline_event DROP CONSTRAINT timeline_event_event_type_check;
ALTER TABLE timeline_event ADD CONSTRAINT timeline_event_event_type_check CHECK (event_type IN
  ('BIRTH','FEEDING','EXCRETION','WEIGHT','VACCINE','APPOINTMENT','PRESCRIPTION','MEDICINE','ALLERGY','MEDICAL_REPORT','IMPORTANT_MEDICAL_EVENT','CUSTOM'));

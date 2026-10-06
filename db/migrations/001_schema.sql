-- 001_schema.sql — core schema (spec §34). All PHI tables carry baby_id NOT NULL.
-- Common audit columns: created_at, created_by, updated_at, updated_by, deleted_at, deleted_by, version.

CREATE EXTENSION IF NOT EXISTS citext;

-- ============ Identity & access ============
CREATE TABLE app_user (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  email citext UNIQUE,
  phone_e164 text UNIQUE CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  guardian_attested_at timestamptz,
  adult_verified_at timestamptz,
  adult_verification_method text,
  locale text NOT NULL DEFAULT 'en-IN',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LOCKED','PENDING_DELETION','DELETED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone_e164 IS NOT NULL)
);

CREATE TABLE auth_challenge (
  id uuid PRIMARY KEY,
  identifier text NOT NULL,                 -- normalised email or E.164 phone
  channel text NOT NULL CHECK (channel IN ('EMAIL','SMS')),
  purpose text NOT NULL DEFAULT 'LOGIN' CHECK (purpose IN ('LOGIN','STEP_UP')),
  user_id uuid REFERENCES app_user(id),
  code_hash text NOT NULL,
  attempts smallint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_challenge_identifier ON auth_challenge(identifier, created_at DESC);

CREATE TABLE user_session (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id),
  token_hash char(64) NOT NULL UNIQUE,
  prev_token_hash char(64),                -- for rotation reuse detection
  device_name text,
  user_agent text,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz NOT NULL DEFAULT now(),
  step_up_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text
);
CREATE INDEX ix_session_user ON user_session(user_id) WHERE revoked_at IS NULL;
CREATE INDEX ix_session_prev ON user_session(prev_token_hash);

CREATE TABLE rate_limit (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  count int NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE household (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE household_member (
  household_id uuid NOT NULL REFERENCES household(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  is_owner boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  PRIMARY KEY (household_id, user_id)
);
CREATE INDEX ix_hm_user ON household_member(user_id) WHERE left_at IS NULL;

CREATE TABLE baby (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES household(id),
  first_name text NOT NULL CHECK (length(first_name) BETWEEN 1 AND 60),
  nickname text CHECK (nickname IS NULL OR length(nickname) <= 40),
  colour_token text NOT NULL CHECK (colour_token IN ('PEACH','SKY','MINT','LILAC','BUTTER','ROSE')),
  photo_document_id uuid,
  sex text NOT NULL CHECK (sex IN ('FEMALE','MALE','NOT_STATED')),
  birth_date date NOT NULL CHECK (birth_date >= DATE '2000-01-01'),
  birth_time time,
  birth_tz text NOT NULL DEFAULT 'Asia/Kolkata',
  multiple_birth_group_id uuid,
  birth_order smallint CHECK (birth_order BETWEEN 1 AND 8),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deleted_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE INDEX ix_baby_household ON baby(household_id) WHERE deleted_at IS NULL;

CREATE TABLE baby_profile (
  baby_id uuid PRIMARY KEY REFERENCES baby(id),
  birth_weight_kg numeric(5,3) CHECK (birth_weight_kg > 0 AND birth_weight_kg < 10),
  birth_length_cm numeric(5,1) CHECK (birth_length_cm > 0 AND birth_length_cm < 80),
  birth_hc_cm numeric(4,1) CHECK (birth_hc_cm > 0 AND birth_hc_cm < 60),
  ga_weeks smallint CHECK (ga_weeks BETWEEN 20 AND 45),
  ga_days smallint CHECK (ga_days BETWEEN 0 AND 6),
  ga_unknown boolean NOT NULL DEFAULT false,
  unable_to_breastfeed boolean,
  show_clinical_references boolean NOT NULL DEFAULT false,
  corrected_age_enabled boolean NOT NULL DEFAULT false,
  nka_confirmed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CHECK (NOT (ga_unknown AND ga_weeks IS NOT NULL)),
  CHECK (ga_days IS NULL OR ga_weeks IS NOT NULL)
);

CREATE TABLE baby_membership (
  baby_id uuid NOT NULL REFERENCES baby(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  role text NOT NULL CHECK (role IN ('OWNER','GUARDIAN','CAREGIVER','VIEWER')),
  can_view_documents boolean NOT NULL DEFAULT true,
  granted_by uuid REFERENCES app_user(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (baby_id, user_id)
);
CREATE INDEX ix_membership_user ON baby_membership(user_id) WHERE revoked_at IS NULL;

CREATE TABLE invitation (
  id uuid PRIMARY KEY,
  baby_id uuid NOT NULL REFERENCES baby(id),
  identifier text NOT NULL,                 -- email or phone of invitee
  role text NOT NULL CHECK (role IN ('GUARDIAN','CAREGIVER','VIEWER')),
  can_view_documents boolean NOT NULL DEFAULT true,
  token_hash char(64) NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz, accepted_by uuid, revoked_at timestamptz
);

CREATE TABLE consent_record (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id),
  purpose text NOT NULL,
  notice_version text NOT NULL,
  granted boolean NOT NULL,
  method text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_consent_user ON consent_record(user_id, recorded_at DESC);

-- ============ Care directory (household-scoped) ============
CREATE TABLE doctor (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES household(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  specialty text, phone text, notes text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, version int NOT NULL DEFAULT 1
);
CREATE TABLE clinic (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES household(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  address text, phone text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, version int NOT NULL DEFAULT 1
);

-- ============ Medical documents (declared early: referenced by others) ============
CREATE TABLE medical_document (
  id uuid PRIMARY KEY,
  baby_id uuid NOT NULL REFERENCES baby(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  doc_type text NOT NULL CHECK (doc_type IN ('LAB_REPORT','IMAGING','DISCHARGE_SUMMARY','PRESCRIPTION_SCAN','VACCINATION_CARD','BIRTH_RECORD','INSURANCE','PHOTO','OTHER')),
  document_date date,
  doctor_id uuid REFERENCES doctor(id), clinic_id uuid REFERENCES clinic(id),
  description text, tags text[] NOT NULL DEFAULT '{}',
  declared_mime text NOT NULL,
  declared_size bigint NOT NULL CHECK (declared_size > 0 AND declared_size <= 20971520),
  quarantine_key text NOT NULL UNIQUE,
  vault_key text UNIQUE,
  mime_detected text,
  size_bytes bigint,
  sha256 char(64),
  page_count int,
  upload_status text NOT NULL DEFAULT 'AWAITING_UPLOAD' CHECK (upload_status IN ('AWAITING_UPLOAD','UPLOADED','PROCESSED','REJECTED')),
  scan_status text NOT NULL DEFAULT 'PENDING' CHECK (scan_status IN ('PENDING','CLEAN','INFECTED','ERROR','REJECTED')),
  scan_detail text,
  scanned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deleted_by uuid, version int NOT NULL DEFAULT 1,
  UNIQUE (id, baby_id)
);
CREATE INDEX ix_doc_baby_date ON medical_document(baby_id, document_date DESC NULLS LAST) WHERE deleted_at IS NULL;
CREATE INDEX ix_doc_tags ON medical_document USING gin(tags);
ALTER TABLE baby ADD CONSTRAINT fk_baby_photo FOREIGN KEY (photo_document_id) REFERENCES medical_document(id) DEFERRABLE INITIALLY DEFERRED;

-- ============ Feeding ============
CREATE TABLE feeding (
  id uuid PRIMARY KEY,
  baby_id uuid NOT NULL REFERENCES baby(id),
  occurred_at timestamptz NOT NULL,
  occurred_tz text NOT NULL,
  local_date date NOT NULL,
  feeding_type text NOT NULL CHECK (feeding_type IN ('DIRECT_BREASTFEEDING','EXPRESSED_BREASTMILK','FORMULA','OTHER')),
  feeding_method text CHECK (feeding_method IN ('BREAST','BOTTLE','CUP','PALADAI','SPOON','TUBE','OTHER')),
  quantity_ml numeric(6,1) CHECK (quantity_ml > 0),
  quantity_oz numeric(6,2) CHECK (quantity_oz > 0),
  entered_unit text CHECK (entered_unit IN ('ML','OZ')),
  quantity_offered_ml numeric(6,1) CHECK (quantity_offered_ml > 0),
  duration_minutes smallint CHECK (duration_minutes BETWEEN 0 AND 240),
  breast_side text CHECK (breast_side IN ('LEFT','RIGHT','BOTH')),
  other_description text,
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  client_id text,
  moved_from_baby_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deleted_by uuid, version int NOT NULL DEFAULT 1,
  CONSTRAINT ck_bf_no_volume CHECK (feeding_type <> 'DIRECT_BREASTFEEDING' OR (quantity_ml IS NULL AND quantity_oz IS NULL AND quantity_offered_ml IS NULL)),
  CONSTRAINT ck_measured_requires_qty CHECK (feeding_type NOT IN ('EXPRESSED_BREASTMILK','FORMULA') OR quantity_ml IS NOT NULL),
  CONSTRAINT ck_side_only_bf CHECK (breast_side IS NULL OR feeding_type = 'DIRECT_BREASTFEEDING'),
  UNIQUE (baby_id, client_id),
  UNIQUE (id, baby_id)
);
CREATE INDEX ix_feeding_baby_day ON feeding(baby_id, local_date) WHERE deleted_at IS NULL;
CREATE INDEX ix_feeding_baby_time ON feeding(baby_id, occurred_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE feeding_plan (
  id uuid PRIMARY KEY,
  baby_id uuid NOT NULL REFERENCES baby(id),
  entered_from text NOT NULL CHECK (entered_from IN ('PRESCRIPTION','DISCHARGE_SUMMARY','VERBAL_INSTRUCTION','OTHER')),
  clinician_name text NOT NULL CHECK (length(clinician_name) BETWEEN 1 AND 120),
  instructed_on date NOT NULL,
  plan_text text NOT NULL CHECK (length(plan_text) BETWEEN 1 AND 2000),
  volume_ml_per_feed numeric(6,1) CHECK (volume_ml_per_feed > 0),
  feeds_per_day smallint CHECK (feeds_per_day BETWEEN 1 AND 24),
  valid_from date NOT NULL, valid_to date,
  attachment_document_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deleted_by uuid, version int NOT NULL DEFAULT 1,
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  FOREIGN KEY (attachment_document_id, baby_id) REFERENCES medical_document(id, baby_id)
);

-- ============ Medical reference (immutable at runtime; loaded by reviewed release) ============
CREATE TABLE reference_source (
  source_id text PRIMARY KEY,
  organization text NOT NULL, document_title text NOT NULL, document_type text NOT NULL,
  country text NOT NULL, tier text NOT NULL, source_url text NOT NULL,
  publication_date text NOT NULL, version text NOT NULL,
  retrieved_at text NOT NULL, verified_at text NOT NULL,
  verification_status text NOT NULL, access_note text
);
CREATE TABLE reference_rule (
  id text PRIMARY KEY,
  bucket text NOT NULL,                     -- feeding_guidelines, clinical_feeding_rules, ...
  source_id text NOT NULL REFERENCES reference_source(source_id),
  population text NOT NULL,
  clinical_context text NOT NULL,
  payload jsonb NOT NULL,                   -- full record incl. values, warnings, provenance (as released)
  release_gate text NOT NULL,
  data_file_sha256 char(64) NOT NULL
);
CREATE TABLE reference_release_log (
  id bigserial PRIMARY KEY,
  rule_id text NOT NULL REFERENCES reference_rule(id),
  previous_gate text NOT NULL, new_gate text NOT NULL,
  clinician_reviewer text NOT NULL, source_checker text NOT NULL,
  page_or_section text, note text,
  released_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reference_conflict (
  id text PRIMARY KEY, payload jsonb NOT NULL
);
CREATE TABLE reference_unsupported (
  id text PRIMARY KEY, payload jsonb NOT NULL
);
CREATE TABLE reference_meta (
  key text PRIMARY KEY, value jsonb NOT NULL
);

-- ============ Growth ============
CREATE TABLE weight_measurement (
  id uuid PRIMARY KEY,
  baby_id uuid NOT NULL REFERENCES baby(id),
  measured_at timestamptz NOT NULL,
  measured_tz text NOT NULL,
  local_date date NOT NULL,
  weight_kg numeric(6,3) CHECK (weight_kg > 0 AND weight_kg < 60),
  length_cm numeric(5,1) CHECK (length_cm > 0 AND length_cm < 200),
  length_position text CHECK (length_position IN ('RECUMBENT','STANDING')),
  head_circumference_cm numeric(4,1) CHECK (head_circumference_cm > 0 AND head_circumference_cm < 80),
  measurement_source text NOT NULL CHECK (measurement_source IN ('HOME_SCALE','CLINIC','HOSPITAL','ANGANWADI','OTHER')),
  notes text,
  client_id text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deleted_by uuid, version int NOT NULL DEFAULT 1,
  CHECK (weight_kg IS NOT NULL OR length_cm IS NOT NULL OR head_circumference_cm IS NOT NULL),
  UNIQUE (baby_id, client_id),
  UNIQUE (id, baby_id)
);
CREATE INDEX ix_wm_baby_time ON weight_measurement(baby_id, measured_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE growth_reference_dataset (
  id text PRIMARY KEY,                      -- e.g. WFA_MALE_DAY
  indicator text NOT NULL,
  sex text NOT NULL CHECK (sex IN ('FEMALE','MALE')),
  x_axis text NOT NULL CHECK (x_axis IN ('AGE_DAYS','LENGTH_CM','HEIGHT_CM')),
  source_file_url text NOT NULL,
  file_sha256 char(64) NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  row_count int NOT NULL,
  validation_report jsonb NOT NULL,
  release_gate text NOT NULL DEFAULT 'HUMAN_RECHECK_REQUIRED'
);
CREATE TABLE growth_reference (
  dataset_id text NOT NULL REFERENCES growth_reference_dataset(id) ON DELETE CASCADE,
  x_value numeric NOT NULL,
  l numeric NOT NULL, m numeric NOT NULL, s numeric NOT NULL,
  sd jsonb,                                 -- published SD columns (SD3neg..SD3) for validation & bands
  PRIMARY KEY (dataset_id, x_value)
);

-- ============ Vaccination ============
CREATE TABLE baby_schedule_selection (
  id uuid PRIMARY KEY,
  baby_id uuid NOT NULL REFERENCES baby(id),
  schedule_id text NOT NULL CHECK (schedule_id IN ('GOVERNMENT_OF_INDIA_UIP','IAP_RECOMMENDED_SCHEDULE')),
  je_opt_in boolean NOT NULL DEFAULT false,
  selected_at timestamptz NOT NULL DEFAULT now(),
  selected_by uuid NOT NULL,
  ended_at timestamptz
);
CREATE UNIQUE INDEX ux_one_active_schedule ON baby_schedule_selection(baby_id) WHERE ended_at IS NULL;

CREATE TABLE appointment (
  id uuid PRIMARY KEY,
  baby_id uuid NOT NULL REFERENCES baby(id),
  doctor_id uuid REFERENCES doctor(id), clinic_id uuid REFERENCES clinic(id),
  starts_at timestamptz NOT NULL, ends_at timestamptz, tz text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('ROUTINE_CHECKUP','VACCINATION','FOLLOW_UP','SPECIALIST','LAB_TEST','OTHER')),
  status text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','COMPLETED','CANCELLED','MISSED')),
  group_id uuid,
  notes_before text, notes_after text,
  reminder_offsets_min int[] NOT NULL DEFAULT '{1440,120}',
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deleted_by uuid, version int NOT NULL DEFAULT 1,
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  UNIQUE (id, baby_id)
);
CREATE INDEX ix_appt_baby_start ON appointment(baby_id, starts_at) WHERE deleted_at IS NULL;

CREATE TABLE vaccination (
  id uuid PRIMARY KEY,
  baby_id uuid NOT NULL REFERENCES baby(id),
  vaccine_code text,                        -- schedule item code when matched
  vaccine_name_as_recorded text NOT NULL CHECK (length(vaccine_name_as_recorded) BETWEEN 1 AND 120),
  dose_label text,
  given_on date NOT NULL,
  schedule_id text, schedule_version_id text, schedule_item_id text,   -- snapshot at time of record; never rewritten
  clinic_id uuid REFERENCES clinic(id),
  given_by text, lot_number text,
  card_document_id uuid,
  appointment_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deleted_by uuid, version int NOT NULL DEFAULT 1,
  FOREIGN KEY (appointment_id, baby_id) REFERENCES appointment(id, baby_id),
  FOREIGN KEY (card_document_id, baby_id) REFERENCES medical_document(id, baby_id),
  UNIQUE (id, baby_id)
);
CREATE INDEX ix_vacc_baby ON vaccination(baby_id, given_on) WHERE deleted_at IS NULL;

-- ============ Prescriptions / medicines / allergies ============
CREATE TABLE prescription (
  id uuid PRIMARY KEY,
  baby_id uuid NOT NULL REFERENCES baby(id),
  doctor_id uuid REFERENCES doctor(id), clinic_id uuid REFERENCES clinic(id),
  appointment_id uuid,
  prescribed_on date NOT NULL,
  diagnosis_text_as_written text,
  attachment_document_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deleted_by uuid, version int NOT NULL DEFAULT 1,
  FOREIGN KEY (appointment_id, baby_id) REFERENCES appointment(id, baby_id),
  FOREIGN KEY (attachment_document_id, baby_id) REFERENCES medical_document(id, baby_id),
  UNIQUE (id, baby_id)
);
CREATE TABLE prescription_item (
  id uuid PRIMARY KEY,
  prescription_id uuid NOT NULL,
  baby_id uuid NOT NULL REFERENCES baby(id),
  medicine_name text NOT NULL CHECK (length(medicine_name) BETWEEN 1 AND 160),
  strength_text text, dosage_text text, frequency_text text, duration_text text, route_text text, instructions_text text,
  sort_order smallint NOT NULL DEFAULT 0,
  FOREIGN KEY (prescription_id, baby_id) REFERENCES prescription(id, baby_id) ON DELETE CASCADE
);

CREATE TABLE medicine (
  id uuid PRIMARY KEY,
  baby_id uuid NOT NULL REFERENCES baby(id),
  medicine_name text NOT NULL CHECK (length(medicine_name) BETWEEN 1 AND 160),
  dose_amount numeric(8,3) CHECK (dose_amount > 0),
  dose_unit text CHECK (dose_unit IN ('ML','MG','DROPS','TABLET','SACHET','PUFF','OTHER')),
  dose_text_as_prescribed text,
  start_date date NOT NULL, end_date date,
  reason_as_given text,
  doctor_id uuid REFERENCES doctor(id),
  prescription_id uuid,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','COMPLETED','STOPPED')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deleted_by uuid, version int NOT NULL DEFAULT 1,
  CHECK (end_date IS NULL OR end_date >= start_date),
  FOREIGN KEY (prescription_id, baby_id) REFERENCES prescription(id, baby_id),
  UNIQUE (id, baby_id)
);
CREATE TABLE medicine_schedule (
  medicine_id uuid PRIMARY KEY,
  baby_id uuid NOT NULL REFERENCES baby(id),
  kind text NOT NULL CHECK (kind IN ('TIMES_OF_DAY','EVERY_N_HOURS','AS_NEEDED')),
  times_of_day text[] CHECK (times_of_day IS NULL OR array_length(times_of_day,1) BETWEEN 1 AND 12),
  every_n_hours smallint CHECK (every_n_hours BETWEEN 1 AND 72),
  anchor_time text,                         -- HH:MM for EVERY_N_HOURS
  tz text NOT NULL,
  reminders_enabled boolean NOT NULL DEFAULT true,
  allow_quiet_hours boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (medicine_id, baby_id) REFERENCES medicine(id, baby_id) ON DELETE CASCADE,
  CHECK (kind <> 'TIMES_OF_DAY' OR times_of_day IS NOT NULL),
  CHECK (kind <> 'EVERY_N_HOURS' OR every_n_hours IS NOT NULL)
);
CREATE TABLE medicine_dose (
  id uuid PRIMARY KEY,
  medicine_id uuid NOT NULL,
  baby_id uuid NOT NULL REFERENCES baby(id),
  scheduled_for timestamptz,
  status text NOT NULL CHECK (status IN ('GIVEN','SKIPPED','MISSED')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  given_at timestamptz,
  given_by uuid,
  notes text,
  client_id text,
  created_by uuid NOT NULL,
  deleted_at timestamptz,
  FOREIGN KEY (medicine_id, baby_id) REFERENCES medicine(id, baby_id),
  UNIQUE (baby_id, client_id)
);
CREATE UNIQUE INDEX ux_dose_slot ON medicine_dose(medicine_id, scheduled_for) WHERE scheduled_for IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE allergy (
  id uuid PRIMARY KEY,
  baby_id uuid NOT NULL REFERENCES baby(id),
  substance text NOT NULL CHECK (length(substance) BETWEEN 1 AND 120),
  category text CHECK (category IN ('FOOD','DRUG','ENVIRONMENTAL','OTHER')),
  reaction_text text,
  severity_reported text NOT NULL DEFAULT 'UNKNOWN' CHECK (severity_reported IN ('MILD','MODERATE','SEVERE','UNKNOWN')),
  status text NOT NULL CHECK (status IN ('SUSPECTED','CONFIRMED_BY_DOCTOR')),
  discovered_on date,
  doctor_id uuid REFERENCES doctor(id),
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deleted_by uuid, version int NOT NULL DEFAULT 1
);
CREATE INDEX ix_allergy_active ON allergy(baby_id) WHERE is_active AND deleted_at IS NULL;

-- ============ Timeline / notifications ============
CREATE TABLE timeline_event (
  id uuid PRIMARY KEY,
  baby_id uuid NOT NULL REFERENCES baby(id),
  event_type text NOT NULL CHECK (event_type IN ('BIRTH','FEEDING','WEIGHT','VACCINE','APPOINTMENT','PRESCRIPTION','MEDICINE','ALLERGY','MEDICAL_REPORT','IMPORTANT_MEDICAL_EVENT','CUSTOM')),
  occurred_at timestamptz NOT NULL,
  occurred_tz text NOT NULL,
  source_table text NOT NULL,
  source_id uuid NOT NULL,
  title text NOT NULL,
  summary text,
  importance smallint NOT NULL DEFAULT 0,
  is_hidden boolean NOT NULL DEFAULT false,
  UNIQUE (source_table, source_id)
);
CREATE INDEX ix_tl_baby_time ON timeline_event(baby_id, occurred_at DESC) WHERE NOT is_hidden;

CREATE TABLE custom_event (
  id uuid PRIMARY KEY,
  baby_id uuid NOT NULL REFERENCES baby(id),
  occurred_at timestamptz NOT NULL, occurred_tz text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  description text,
  is_important_medical boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz, version int NOT NULL DEFAULT 1
);

CREATE TABLE notification (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id),
  baby_id uuid REFERENCES baby(id),
  kind text NOT NULL,
  title text NOT NULL,
  body text,
  target_path text,
  scheduled_for timestamptz NOT NULL,
  sent_at timestamptz,
  read_at timestamptz,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED','CANCELLED')),
  dedupe_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_notif_due ON notification(status, scheduled_for);
CREATE INDEX ix_notif_user ON notification(user_id, scheduled_for DESC);

CREATE TABLE push_subscription (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id),
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL, auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz, failure_count int NOT NULL DEFAULT 0
);

-- ============ Export / share / deletion / idempotency ============
CREATE TABLE share_link (
  id uuid PRIMARY KEY,
  baby_id uuid NOT NULL REFERENCES baby(id),
  created_by uuid NOT NULL REFERENCES app_user(id),
  scope jsonb NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  max_views int, view_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE export_job (
  id uuid PRIMARY KEY,
  requested_by uuid NOT NULL REFERENCES app_user(id),
  baby_id uuid NOT NULL REFERENCES baby(id),
  scope jsonb NOT NULL,
  format text NOT NULL CHECK (format IN ('PDF_VISIT_SUMMARY','JSON','CSV')),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','READY','FAILED','EXPIRED')),
  storage_key text,
  download_token_hash char(64),
  downloaded_at timestamptz,
  expires_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE deletion_request (
  id uuid PRIMARY KEY,
  requested_by uuid NOT NULL REFERENCES app_user(id),
  target_type text NOT NULL CHECK (target_type IN ('ACCOUNT','BABY')),
  target_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  purge_after timestamptz NOT NULL,
  cancelled_at timestamptz,
  completed_at timestamptz
);
CREATE TABLE idempotency_key (
  key text NOT NULL,
  user_id uuid NOT NULL,
  request_hash char(64) NOT NULL,
  status_code int NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- ============ Audit (append-only, hash-chained) ============
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_ip inet,
  session_id uuid,
  baby_id uuid,
  action text NOT NULL,
  entity_table text,
  entity_id text,
  detail jsonb,
  request_id text,
  chain_key text NOT NULL,
  prev_hash char(64),
  row_hash char(64) NOT NULL
);
CREATE INDEX ix_audit_baby_time ON audit_log(baby_id, occurred_at DESC);
CREATE INDEX ix_audit_chain ON audit_log(chain_key, id DESC);

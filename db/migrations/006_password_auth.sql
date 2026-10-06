-- Email + password sign-in (alongside one-time codes).
-- Hashes are only ever read in system context (sign-in, step-up); never visible to a user-scoped query.
CREATE TABLE user_password (
  user_id uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  password_hash text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_password ENABLE ROW LEVEL SECURITY; ALTER TABLE user_password FORCE ROW LEVEL SECURITY;
CREATE POLICY user_password_system ON user_password USING (app_is_system()) WITH CHECK (app_is_system());

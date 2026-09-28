-- Password reset tokens for parent (Viewer) self-service password recovery.
-- A row is created when a parent requests a reset; the emailed link carries the
-- raw token, only its SHA-256 hash is stored. Tokens are single-use and expire.
CREATE TABLE IF NOT EXISTS password_resets (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash ON password_resets (token_hash);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (user_id);

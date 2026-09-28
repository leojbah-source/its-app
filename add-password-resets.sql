-- ============================================================================
-- ITS 2026 — add password_resets table (parent forgot-password flow)
-- ============================================================================
-- Stores single-use, time-limited password reset tokens. The emailed link
-- carries the raw token; only its SHA-256 hash is stored here.
--
-- Additive and idempotent — safe to run on staging and production while
-- registrations are live (creates a new table only, touches no existing data).
-- Run on STAGING first, then PRODUCTION:
--   psql "<External Database URL>?sslmode=require" -f add-password-resets.sql
-- ============================================================================

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

-- Verify
SELECT table_name FROM information_schema.tables WHERE table_name = 'password_resets';

-- ============================================================================
-- Migration 011 — Admin verification workflow + working audit trail
-- 1. audit_log: drop the INSERT/UPDATE/DELETE-only CHECK so application-level
--    actions ('CONFIRM_PAYMENT', 'ADMIN_VERIFY_CPR', …) can be recorded.
--    NOTE: utils/audit.js previously wrote to non-existent columns and every
--    audit insert silently failed — fixed together with this migration.
-- 2. participants: admin CPR/identity verification state.
-- Idempotent: safe to run repeatedly.
-- ============================================================================

BEGIN;

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;

ALTER TABLE participants
  ADD COLUMN IF NOT EXISTS admin_verified_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (admin_verified_status IN ('pending','verified','issue')),
  ADD COLUMN IF NOT EXISTS admin_verified_by INT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS admin_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_verify_note TEXT;

COMMIT;

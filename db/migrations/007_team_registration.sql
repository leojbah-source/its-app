-- ============================================================================
-- Migration 007 — Team registration flow (parent portal)
--   teams.created_by  — parent account that registered the team ("my teams")
--   payments.team_id  — per-team fee payments (§4.1: team fee is per team)
-- Idempotent: safe to run repeatedly.
-- ============================================================================

BEGIN;

ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id);

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS team_id INT REFERENCES teams(id);

CREATE INDEX IF NOT EXISTS idx_payments_team ON payments (team_id);

COMMIT;

-- ============================================================================
-- Migration 012 — Team captain & teacher names for team events
--   teams.captain_phone     — contact number for the team captain (member 1)
--   team_members.is_captain — marks the captain row
-- Idempotent: safe to run repeatedly.
-- ============================================================================

BEGIN;

ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS captain_phone TEXT;

ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS is_captain BOOL NOT NULL DEFAULT FALSE;

COMMIT;

-- ============================================================================
-- Migration 050 — Schedule phasing
--   venues.blocked_dates  — specific dates a hall is NOT available (blocked for
--                           another function), even if its weekday hours allow.
--   schedule.is_locked    — a LOCKED row is a committed phase: the scheduler
--                           seeds it as a fixed booking and never moves or
--                           regenerates it, so a later phase is built around it.
-- Idempotent: safe to run repeatedly.
-- ============================================================================

BEGIN;

ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS blocked_dates DATE[] NOT NULL DEFAULT '{}';

ALTER TABLE schedule
  ADD COLUMN IF NOT EXISTS is_locked BOOL NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by INT REFERENCES users(id);

COMMENT ON COLUMN venues.blocked_dates IS 'Specific dates this venue is unavailable (blocked for another function), even if its weekday hours otherwise allow it.';
COMMENT ON COLUMN schedule.is_locked IS 'A locked row is a committed scheduling phase: the generator seeds it as a fixed booking and never moves or regenerates it (phased scheduling).';

COMMIT;

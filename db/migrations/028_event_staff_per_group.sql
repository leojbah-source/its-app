-- ============================================================================
-- Migration 028 — MC / Timer assignment per (event + age group)
-- Like judges: an MC/Timer is assigned to a specific age group of an event, so
-- the same MC can cover G2 & G3 (same hall, back-to-back) while G5 (another hall)
-- and G4 (another date) get their own. Clears existing event-wide MC/Timer
-- assignments (re-assign per group). Idempotent.
-- ============================================================================

BEGIN;

-- ONE-TIME reset ONLY. This migration re-runs on every server boot, so the
-- wipe must happen just once — when mc_assignments is still in the old
-- per-event shape (age_group_id not yet added). Without this guard, every
-- deploy wiped all MC and Timer assignments.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'mc_assignments' AND column_name = 'age_group_id') THEN
    DELETE FROM mc_assignments;
    DELETE FROM timer_assignments;
  END IF;
END $$;

ALTER TABLE mc_assignments    ADD COLUMN IF NOT EXISTS age_group_id INT REFERENCES age_groups(id);
ALTER TABLE timer_assignments ADD COLUMN IF NOT EXISTS age_group_id INT REFERENCES age_groups(id);

ALTER TABLE mc_assignments    DROP CONSTRAINT IF EXISTS mc_assignments_user_id_event_id_key;
ALTER TABLE timer_assignments DROP CONSTRAINT IF EXISTS timer_assignments_user_id_event_id_key;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mc_assignments_user_event_group_key') THEN
    ALTER TABLE mc_assignments ADD CONSTRAINT mc_assignments_user_event_group_key UNIQUE (user_id, event_id, age_group_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'timer_assignments_user_event_group_key') THEN
    ALTER TABLE timer_assignments ADD CONSTRAINT timer_assignments_user_event_group_key UNIQUE (user_id, event_id, age_group_id);
  END IF;
END $$;

COMMIT;

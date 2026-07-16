-- ============================================================================
-- Migration 017 — Chest numbering per AGE GROUP
-- Chest numbers restart at 1 for each age group within an event (groups are
-- conducted one after another; numbers don't carry forward). The original
-- UNIQUE(event_id, chest_number) forbade two groups both having chest #1 —
-- replace it with UNIQUE(event_id, age_group_id, chest_number).
-- Idempotent: safe to run repeatedly.
-- ============================================================================

BEGIN;

-- 1. New column (nullable; backfilled from the registration's age group).
ALTER TABLE chest_assignments
  ADD COLUMN IF NOT EXISTS age_group_id INT REFERENCES age_groups(id);

-- 2. Backfill existing rows from their registration.
UPDATE chest_assignments ca
   SET age_group_id = r.age_group_id
  FROM registrations r
 WHERE r.id = ca.registration_id AND ca.age_group_id IS NULL;

-- 3. Swap the uniqueness: event-wide → per (event, age group).
ALTER TABLE chest_assignments
  DROP CONSTRAINT IF EXISTS chest_assignments_event_id_chest_number_key;

ALTER TABLE chest_assignments
  DROP CONSTRAINT IF EXISTS chest_assignments_event_group_chest_key;
ALTER TABLE chest_assignments
  ADD CONSTRAINT chest_assignments_event_group_chest_key
  UNIQUE (event_id, age_group_id, chest_number);

COMMENT ON COLUMN chest_assignments.age_group_id IS 'Age group this chest belongs to; chest numbers restart at 1 per (event, age_group).';

COMMIT;

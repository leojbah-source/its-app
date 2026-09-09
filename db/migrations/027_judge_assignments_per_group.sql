-- ============================================================================
-- Migration 027 — judge assignment per (event + age group)
-- Judges are now assigned to a specific age group of an event, not the whole
-- event, so different judges can score G2, G3, G5 etc. independently.
--
-- Per the operator's choice ("clear and start fresh"), existing event-wide
-- assignments (and the scores tied to them) are removed so judges are
-- re-assigned per age group. This resets judging test data only — registrations,
-- chest numbers, attendance and results config are untouched (recompute results
-- after re-scoring). Idempotent.
-- ============================================================================

BEGIN;

-- scores reference judge_assignments; clear them first, then the assignments.
DELETE FROM scores;
DELETE FROM judge_assignments;

ALTER TABLE judge_assignments ADD COLUMN IF NOT EXISTS age_group_id INT REFERENCES age_groups(id);

-- Replace the old per-event uniqueness with per-(event, age group).
ALTER TABLE judge_assignments DROP CONSTRAINT IF EXISTS judge_assignments_judge_id_event_id_time_slot_id_key;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'judge_assignments_judge_event_group_key') THEN
    ALTER TABLE judge_assignments
      ADD CONSTRAINT judge_assignments_judge_event_group_key UNIQUE (judge_id, event_id, age_group_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_judge_assignments_event_group ON judge_assignments(event_id, age_group_id);

COMMENT ON COLUMN judge_assignments.age_group_id IS 'The age group this judge scores for the event. Each (event, age_group) is judged independently (rule: event treated as a separate contest per age group).';

COMMIT;

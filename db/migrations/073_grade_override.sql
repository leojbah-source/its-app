-- 073_grade_override.sql
-- Chairman-only manual grade override on a result. Reflected in grade + grade_points
-- and preserved across recompute. Validation (A/B/C) is enforced in the API.
-- Idempotent: adds the column only if missing.
ALTER TABLE event_results ADD COLUMN IF NOT EXISTS grade_override TEXT;

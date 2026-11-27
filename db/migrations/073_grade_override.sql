-- 073_grade_override.sql
-- Chairman-only manual grade override on a result (e.g. a divergent judge pulled the
-- average just under a band). When set, it is reflected in grade + grade_points and
-- survives recompute. Idempotent.
ALTER TABLE event_results
  ADD COLUMN IF NOT EXISTS grade_override TEXT
    CHECK (grade_override IS NULL OR grade_override IN ('A','B','C'));

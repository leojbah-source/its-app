-- ============================================================================
-- Migration 019 — All judges must AGREE the criteria weightages before scoring
-- Each judge assignment records when that judge agreed to the current
-- weightages. Changing the weightages resets all agreements for the event;
-- scoring is blocked until every assigned judge has agreed.
-- Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE judge_assignments
  ADD COLUMN IF NOT EXISTS weightages_agreed_at TIMESTAMPTZ;

COMMENT ON COLUMN judge_assignments.weightages_agreed_at IS 'When this judge agreed the current criteria weightages; NULL = not agreed (or reset by a weightage change). All assigned judges must agree before scoring.';

COMMIT;

-- ============================================================================
-- Migration 029 — judge single-session + "done scoring"
--  * judges.active_session: the current login's session token. A new OTP login
--    rotates it, so older judge screens are signed out (one active screen).
--  * judge_assignments.scoring_done_at: when this judge marked scoring finished
--    for their (event, age group). Results can only be finalised once all of a
--    group's judges have marked done.
-- Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE judges            ADD COLUMN IF NOT EXISTS active_session  TEXT;
ALTER TABLE judge_assignments ADD COLUMN IF NOT EXISTS scoring_done_at TIMESTAMPTZ;

COMMIT;

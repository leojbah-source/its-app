-- ============================================================================
-- Migration 024 — backfill events.gender_split from event names
-- The gender_split column (003) drives registration gender eligibility, but the
-- Boys/Girls distinction had only been captured in the event NAME. This sets
-- gender_split for those events so a participant only sees events for their own
-- gender. Gender-neutral events keep their existing value ('common'/'none').
-- Idempotent (re-running changes nothing once set). Admins can override any of
-- these in Events → edit → "Gender split".
-- ============================================================================

BEGIN;

UPDATE events
   SET gender_split = 'boys', updated_at = now()
 WHERE event_name ILIKE '%boys%' AND gender_split <> 'boys';

UPDATE events
   SET gender_split = 'girls', updated_at = now()
 WHERE event_name ILIKE '%girls%' AND gender_split <> 'girls';

COMMIT;

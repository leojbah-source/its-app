-- ============================================================================
-- Migration 010 — CPR verification method + participant ownership
-- 1. cpr_verified_method: whether CPR details came from the camera OCR scan
--    or manual entry (admin filter: Verified CPR OCR/Manual).
-- 2. created_by: the parent account that created the participant.
--    (participants.pwa_username is OVERWRITTEN by trg fn_generate_pwa_username
--    with the name+CPR login, so it must never be used to link to users —
--    earlier code did, which silently broke 'my participants' for children
--    with no event registrations yet.)
-- Idempotent: safe to run repeatedly.
-- ============================================================================

BEGIN;

ALTER TABLE participants
  ADD COLUMN IF NOT EXISTS cpr_verified_method TEXT NOT NULL DEFAULT 'manual'
    CHECK (cpr_verified_method IN ('ocr','manual')),
  ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id);

-- Backfill ownership from event registrations where possible
UPDATE participants p SET created_by = sub.registered_by
FROM (SELECT DISTINCT ON (participant_id) participant_id, registered_by
      FROM registrations WHERE participant_id IS NOT NULL AND registered_by IS NOT NULL
      ORDER BY participant_id, registered_at) sub
WHERE p.id = sub.participant_id AND p.created_by IS NULL;

COMMIT;

-- ============================================================================
-- Migration 051 — Per-row schedule review marker
--   schedule.looks_good — review state used by the Schedule grid toggle
--                         (draft -> looks good -> locked). Cosmetic: only a
--                         LOCKED row (is_locked) or a non-draft status is kept
--                         when regenerating; 'looks good' is still a draft.
-- Idempotent.
-- ============================================================================
BEGIN;
ALTER TABLE schedule ADD COLUMN IF NOT EXISTS looks_good BOOL NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN schedule.looks_good IS 'Per-row review marker (draft -> looks good -> locked). Cosmetic; only is_locked or a non-draft status protects a row from regeneration.';
COMMIT;

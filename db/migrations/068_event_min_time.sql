-- ============================================================================
-- Migration 068 — minimum performance time per event
-- Some events (e.g. a speech contest) require a MINIMUM time; a performance
-- under it should be flagged to the judges so they do not score it. 0 = no
-- minimum (default), so every existing event is unaffected. Overtime/DQ handling
-- is unchanged. Idempotent.
-- ============================================================================
ALTER TABLE events ADD COLUMN IF NOT EXISTS min_time_seconds INT NOT NULL DEFAULT 0;
COMMENT ON COLUMN events.min_time_seconds IS 'Minimum performance time in seconds (0 = none). Below this, the judge screen flags the chest as not meeting the minimum timing; judges then skip scoring it.';

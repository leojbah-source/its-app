-- ============================================================================
-- Migration 015 — Scheduling controls (event placement preferences)
-- Adds admin-settable controls that steer the auto-schedule draft:
--   events.preferred_venue_id  — soft venue pin: the scheduler tries this
--                    venue FIRST for the event; falls back to other suitable
--                    venues if it genuinely can't fit (flagged in the report).
--                    e.g. Fashion Show / Fancy Dress → VKL Hall (ramp).
--   events.keep_groups_together — TRUE: all of the event's age groups run as
--                    ONE continuous block in ONE venue (overrides the age-group
--                    split limit). For ramp/setup reuse (Fashion Show).
--   events.requires_tables — TRUE: a "table" event (drawing, spelling,
--                    handwriting, clay modelling…). All age groups run
--                    SIMULTANEOUSLY across all available venues, and table
--                    events are scheduled consecutively so tables are set up
--                    once. (Seated/non-stage by nature.)
--   categories.not_before_date — earliest date this category's events may be
--                    scheduled (e.g. Natya/dance late in the window so kids get
--                    more practice time). NULL = no restriction.
-- Idempotent: safe to run repeatedly.
-- ============================================================================

BEGIN;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS preferred_venue_id   INT REFERENCES venues(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS keep_groups_together BOOL NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS requires_tables      BOOL NOT NULL DEFAULT FALSE;

ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS not_before_date      DATE;

COMMENT ON COLUMN events.preferred_venue_id   IS 'Soft venue pin: scheduler tries this venue first, falls back if it cannot fit.';
COMMENT ON COLUMN events.keep_groups_together IS 'TRUE: all age groups scheduled as one continuous block in one venue (overrides split limit).';
COMMENT ON COLUMN events.requires_tables      IS 'TRUE: table event — all age groups run concurrently across venues; table events run consecutively.';
COMMENT ON COLUMN categories.not_before_date  IS 'Earliest date this category''s events may be scheduled (NULL = no restriction).';

COMMIT;

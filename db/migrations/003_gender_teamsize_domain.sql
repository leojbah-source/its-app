-- ============================================================================
-- Migration 003 — Blueprint §4.1 completeness: gender split, team sizes,
--                 website domain, per-team fee
-- Idempotent: safe to run repeatedly.
-- ============================================================================

BEGIN;

-- Event gender split (§4.1): who may enter the event.
--   'common' = all, 'boys' = M only, 'girls' = F only, 'none' = n/a (treated as common)
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS gender_split TEXT NOT NULL DEFAULT 'common'
    CHECK (gender_split IN ('none','boys','girls','common'));

-- Year-level defaults for team size (§4.1: min 5, max 10, configurable).
-- events.min/max_participants_per_team override these per event when set.
ALTER TABLE year_config
  ADD COLUMN IF NOT EXISTS team_size_min INT NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS team_size_max INT NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS website_domain TEXT,
  -- Competition window (§4.7 Auto Schedule inputs). The Year Setup page and
  -- PUT /config/active always referenced these, but schema.sql never created
  -- them — the config save was silently broken until this migration.
  ADD COLUMN IF NOT EXISTS event_start_date DATE,
  ADD COLUMN IF NOT EXISTS event_end_date DATE,
  -- Also referenced by routes/UI but never created in schema.sql:
  ADD COLUMN IF NOT EXISTS its_logo_url TEXT,
  ADD COLUMN IF NOT EXISTS grade_c_pct NUMERIC(5,2) NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS tiebreaker_scale_max INT NOT NULL DEFAULT 10;

-- Team event fee is charged PER TEAM (§4.1), snapshotted at team creation.
-- Member rate applies when every team member has active KCA membership.
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS fee_amount NUMERIC(10,3) NOT NULL DEFAULT 0;

COMMIT;

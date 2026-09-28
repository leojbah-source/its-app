-- ============================================================================
-- ITS 2026 — post-registration consolidation (merge / cancel / split)
-- ============================================================================
-- Adds the schema for consolidating entry lists after the Initial list is
-- published: a marker on generated events, a Final-list flag, and the
-- event_consolidations audit/revert table.
--
-- Additive and idempotent — safe to run on staging and production while
-- registrations are live (new columns + one new table only; existing rows and
-- registrations are untouched).
-- Run on STAGING first, then PRODUCTION:
--   psql "<External Database URL>?sslmode=require" -f add-event-consolidation.sql
-- ============================================================================

ALTER TABLE events ADD COLUMN IF NOT EXISTS is_generated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS origin_note TEXT;

ALTER TABLE year_config ADD COLUMN IF NOT EXISTS final_list_published BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE year_config ADD COLUMN IF NOT EXISTS final_list_published_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS event_consolidations (
  id                SERIAL PRIMARY KEY,
  year_id           INTEGER NOT NULL REFERENCES year_config(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('merge','cancel','split')),
  source_event_ids  INTEGER[] NOT NULL DEFAULT '{}',
  target_event_ids  INTEGER[] NOT NULL DEFAULT '{}',
  age_group_id      INTEGER REFERENCES age_groups(id),
  moved             JSONB NOT NULL DEFAULT '[]',
  note              TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reverted_at       TIMESTAMPTZ,
  reverted_by       INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_event_consolidations_year ON event_consolidations (year_id, reverted_at);
CREATE INDEX IF NOT EXISTS idx_event_consolidations_ag ON event_consolidations (age_group_id);

-- Verify
SELECT table_name FROM information_schema.tables WHERE table_name = 'event_consolidations';
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'events' AND column_name IN ('is_generated','origin_note')
 ORDER BY column_name;

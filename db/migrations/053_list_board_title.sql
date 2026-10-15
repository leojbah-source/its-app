-- ============================================================================
-- Migration 053 — Configurable title for the public Participants-List card
-- The PWA board card that lists the per-age-group PDFs had a hard-coded title
-- "Initial Participants List". Make it a year_config text field so the office
-- can set it ("Final Participants List", etc.) from Year Setup each year.
-- Default 'Final Participants List' (backfills the current row on ADD).
-- Idempotent.
-- ============================================================================
ALTER TABLE year_config
  ADD COLUMN IF NOT EXISTS list_board_title TEXT DEFAULT 'Final Participants List';

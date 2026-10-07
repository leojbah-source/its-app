-- ============================================================================
-- ITS 2026 — Deferred judging flag (writing/drawing events judged later)
-- ============================================================================
-- Marks events whose criteria are fixed by the Chairman and scored without the
-- per-group agreement step (one judge at a time with the originals).
-- Additive and idempotent — safe on staging and production live data.
--   psql "<External Database URL>?sslmode=require" -f add-deferred-judging.sql
-- ============================================================================
ALTER TABLE events ADD COLUMN IF NOT EXISTS deferred_judging BOOLEAN NOT NULL DEFAULT FALSE;

-- Verify
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name = 'events' AND column_name = 'deferred_judging';

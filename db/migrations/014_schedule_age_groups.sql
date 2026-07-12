-- ============================================================================
-- Migration 014 — Schedule rows are per event × age-group batch
-- An event with many entries is scheduled as several sessions, each covering
-- 1–3 (consecutive) age groups. The batch's groups are recorded on the row.
-- Idempotent: safe to run repeatedly.
-- ============================================================================

ALTER TABLE schedule
  ADD COLUMN IF NOT EXISTS age_groups TEXT;   -- e.g. 'G1, G2'

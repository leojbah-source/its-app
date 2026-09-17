-- ============================================================================
-- ITS 2026 — add participants.confirmed_at
-- ============================================================================
-- Marks when a parent completed a registration (clicked "Complete Registration",
-- which requires a payment). The admin Registrations / Participants / Event
-- Summary views and the CSV export show only completed registrations; in-progress
-- ones stay hidden behind the "In progress" filter.
--
-- Additive and idempotent — safe to run on staging and production.
-- ⚠️ Run this BEFORE pushing the matching code (the code reads this column).
--   psql "<External Database URL>?sslmode=require" -f add-confirmed-at.sql
-- ============================================================================

ALTER TABLE participants
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'participants' AND column_name = 'confirmed_at';

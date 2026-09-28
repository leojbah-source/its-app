-- ============================================================================
-- ITS 2026 — consolidation batch-notification tracking
-- ============================================================================
-- Adds notified_at / notified_by to event_consolidations so the "Send
-- notifications" step sends one consolidated message per parent and never
-- re-sends a change that was already notified.
--
-- Additive and idempotent — safe on staging and production.
-- Run on STAGING first, then PRODUCTION:
--   psql "<External Database URL>?sslmode=require" -f add-consolidation-notified.sql
-- ============================================================================

ALTER TABLE event_consolidations ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
ALTER TABLE event_consolidations ADD COLUMN IF NOT EXISTS notified_by INTEGER REFERENCES users(id);

-- Verify
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'event_consolidations' AND column_name IN ('notified_at','notified_by')
 ORDER BY column_name;

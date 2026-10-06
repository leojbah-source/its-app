-- ============================================================================
-- ITS 2026 — Registration source ("How did you hear about ITS this year?")
-- ============================================================================
-- Adds two nullable columns to users, filled at parent sign-up. Multi-select
-- stored as a text array; an optional free-text note captures "Other".
-- Additive and idempotent — safe on staging and production live data.
-- Run BEFORE deploying the code that uses it:
--   psql "<External Database URL>?sslmode=require" -f add-registration-source.sql
-- ============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS heard_about_sources TEXT[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS heard_about_other   TEXT;

-- Verify
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name = 'users' AND column_name IN ('heard_about_sources','heard_about_other')
 ORDER BY column_name;

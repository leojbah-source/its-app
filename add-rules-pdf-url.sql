-- ============================================================================
-- ITS 2026 — add year_config.rules_pdf_url
-- ============================================================================
-- Adds the column that stores the uploaded General Rules & Regulations PDF URL
-- (surfaced on the registration landing page and the agreement checkbox).
--
-- Additive and idempotent — safe to run on staging and production.
-- Run on STAGING first, then PRODUCTION:
--   psql "<External Database URL>?sslmode=require" -f add-rules-pdf-url.sql
-- ============================================================================

ALTER TABLE year_config
  ADD COLUMN IF NOT EXISTS rules_pdf_url text;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'year_config' AND column_name = 'rules_pdf_url';

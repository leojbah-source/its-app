-- ============================================================================
-- ITS 2026 — add the 'Media' user role (results view + winners poster only)
-- ============================================================================
-- Adds a new value to the user_role enum. Additive and idempotent — safe on
-- staging and production. Run BEFORE deploying the code that assigns this role.
--   psql "<External Database URL>?sslmode=require" -f add-media-role.sql
-- ============================================================================
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'Media';

-- Verify
SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
 WHERE t.typname = 'user_role' ORDER BY e.enumsortorder;

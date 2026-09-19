-- ============================================================================
-- ITS 2026 — add Registrar & Accountant staff roles
-- ============================================================================
-- Adds two values to the user_role enum so these accounts can be created.
-- Registrar   → Registrations only (verify CPR/DOB, chase & confirm cash payments).
-- Accountant  → Payments + Finance only (verify BenefitPay / bank, reject with a
--               reason, add finance entries).
--
-- Idempotent and safe to run on staging and production.
-- ⚠️ Run this BEFORE pushing the matching code (the code references these roles).
--   psql "<External Database URL>?sslmode=require" -f add-registrar-accountant-roles.sql
--
-- Note: ADD VALUE cannot run inside an explicit transaction block, so this file
-- has no BEGIN/COMMIT — run it as-is.
-- ============================================================================

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'Registrar';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'Accountant';

-- Verify
SELECT unnest(enum_range(NULL::user_role))::text AS role ORDER BY 1;

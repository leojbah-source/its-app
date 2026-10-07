-- ============================================================================
-- ITS 2026 — Second parent WhatsApp number (Dad & Mom)
-- ============================================================================
-- Adds one nullable column to users; parents may add a second WhatsApp number
-- at sign-up or from their account, and both numbers receive messages.
-- Additive and idempotent — safe on staging and production live data.
--   psql "<External Database URL>?sslmode=require" -f add-parent-whatsapp-2.sql
-- ============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_number_2 TEXT;

-- Verify
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name = 'users' AND column_name = 'whatsapp_number_2';

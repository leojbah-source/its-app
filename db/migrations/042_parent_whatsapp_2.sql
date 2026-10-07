-- Second parent WhatsApp number (Dad & Mom): an optional additional WhatsApp
-- contact on the parent account so both receive registration messages.
-- Additive + idempotent — safe on live data; existing parents have NULL.
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_number_2 TEXT;

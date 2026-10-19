-- Migration 058 — WhatsApp group invite link (one general link per year).
-- Used by the "email schedule to parents" message and anywhere the official
-- group invite is shown. Idempotent.
ALTER TABLE year_config ADD COLUMN IF NOT EXISTS wa_group_link TEXT;

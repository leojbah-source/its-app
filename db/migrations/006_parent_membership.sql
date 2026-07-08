-- ============================================================================
-- Migration 006 — Parent-level KCA membership & subscription check
-- Membership belongs to the PARENT account (collected at signup, §4.3):
--   users.kca_member_no      — KCA member ID entered at account creation
--   users.whatsapp_number    — WhatsApp contact (may differ from phone)
--   users.membership_status  — none | active | lapsed | pending
--                              (pending = verification API unreachable)
--   users.membership_checked_at — when last verified against mem.kcabah.com
-- year_config.member_subscription_upto — 'YYYY-MM' the subscription must be
--   paid up to for member rates to apply this year (set in Year Setup).
-- Idempotent: safe to run repeatedly.
-- ============================================================================

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS whatsapp_number TEXT,
  ADD COLUMN IF NOT EXISTS kca_member_no TEXT,
  ADD COLUMN IF NOT EXISTS membership_status TEXT NOT NULL DEFAULT 'none'
    CHECK (membership_status IN ('none','active','lapsed','pending')),
  ADD COLUMN IF NOT EXISTS membership_checked_at TIMESTAMPTZ;

ALTER TABLE year_config
  ADD COLUMN IF NOT EXISTS member_subscription_upto TEXT;  -- 'YYYY-MM'

COMMIT;

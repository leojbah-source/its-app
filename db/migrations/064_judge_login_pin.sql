-- Migration 064 — optional shared PIN for judge login.
-- When set, judges sign in with their phone number + this 4-digit PIN instead
-- of a one-time OTP (simpler to run on the day). Leave blank to require OTPs.
ALTER TABLE year_config ADD COLUMN IF NOT EXISTS judge_login_pin TEXT;

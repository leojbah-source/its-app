-- ============================================================================
-- Migration 016 — Judge bios, fields of expertise, and OTP storage
--   judges.detailed_bio — long-form intro used by the MCs' script (the brief
--                    `bio` stays as the short public blurb).
--   judges.expertise    — category codes the judge can adjudicate
--                    (NATYA/SANGEET/KALA/SAHITYA/ADDON/TEAM); powers "find a
--                    judge for this event" later. TEXT[] like venues.suitable_for.
--   otp_codes           — was referenced by utils/otp.js but never created,
--                    so the judge OTP button raised
--                    'relation "otp_codes" does not exist'. Create it.
-- Idempotent: safe to run repeatedly.
-- ============================================================================

BEGIN;

ALTER TABLE judges
  ADD COLUMN IF NOT EXISTS detailed_bio TEXT,
  ADD COLUMN IF NOT EXISTS expertise    TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN judges.detailed_bio IS 'Long-form introduction read by the MCs; the MC script pulls the detailed_bio of the 3 judges assigned to an event.';
COMMENT ON COLUMN judges.expertise    IS 'Category codes this judge can adjudicate (matches categories.code) — used to search judges by field of expertise.';

CREATE TABLE IF NOT EXISTS otp_codes (
    id           SERIAL PRIMARY KEY,
    phone        TEXT NOT NULL,
    code         TEXT NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    consumed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_otp_codes_phone ON otp_codes(phone, created_at DESC);

COMMENT ON TABLE otp_codes IS 'Short-lived login OTPs (judge briefing login, rule #12). createOtp() inserts, verifyOtp() consumes; expired/consumed rows are ignored.';

COMMIT;

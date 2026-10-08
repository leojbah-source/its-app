-- ============================================================================
-- Migration 045 — Standing (non-expiring, reusable) OTP codes
-- ============================================================================
-- Judge login OTPs are normally one-shot and expire in OTP_EXPIRY_MINUTES.
-- For DEFERRED-judging events (Essay/handwriting/drawing), judges score over
-- several days, so their code must stay valid until the Chairman resets or
-- resends it. A "standing" code has no expiry and is not consumed on use.
-- Additive + idempotent — safe on live data.
-- ============================================================================

ALTER TABLE otp_codes ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS standing BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN otp_codes.standing IS 'TRUE = a standing code for deferred-judging events: no expiry (expires_at NULL) and not consumed on verify; stays valid until the Chairman resends or resets it.';

-- Verify
SELECT 'otp_codes.standing' AS check,
       (SELECT COUNT(*) FROM otp_codes WHERE standing)::text AS standing_rows;

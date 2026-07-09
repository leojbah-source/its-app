-- ============================================================================
-- Migration 009 — CPR back-side scan
-- The DOB (and the machine-readable zone) is on the BACK of the Bahrain CPR
-- card; both sides are kept on record per participant.
-- Idempotent: safe to run repeatedly.
-- ============================================================================

ALTER TABLE participants
  ADD COLUMN IF NOT EXISTS cpr_scan_back_url TEXT;

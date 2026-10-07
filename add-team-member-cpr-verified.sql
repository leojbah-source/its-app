-- ============================================================================
-- ITS 2026 — Team member CPR-verified tick (team View)
-- ============================================================================
-- Adds a per-member CPR-verified flag so the checker can tick each team member
-- as verified from the team View. Additive and idempotent — safe on live data.
--   psql "<External Database URL>?sslmode=require" -f add-team-member-cpr-verified.sql
-- ============================================================================
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS cpr_verified    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS cpr_verified_at TIMESTAMPTZ;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS cpr_verified_by INT REFERENCES users(id);

-- Verify
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'team_members' AND column_name LIKE 'cpr_verified%' ORDER BY column_name;

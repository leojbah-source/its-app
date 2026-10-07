-- Team CPR check: let the verifier tick each team member as CPR-verified from
-- the team View (separate from attendance confirmation). Additive + idempotent.
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS cpr_verified    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS cpr_verified_at TIMESTAMPTZ;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS cpr_verified_by INT REFERENCES users(id);

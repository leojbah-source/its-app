-- Migration 063 — separate, later deadline for entering remaining team members.
-- A team is created (with the captain) by team_reg_deadline, but the details of
-- the other members can be added right up to this later date. Falls back to
-- team_reg_deadline when left blank. Idempotent.
ALTER TABLE year_config ADD COLUMN IF NOT EXISTS team_member_deadline TIMESTAMPTZ;

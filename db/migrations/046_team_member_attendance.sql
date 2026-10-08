-- ============================================================================
-- Migration 046 — Per-member attendance for team events
-- ============================================================================
-- Teams are marked present/absent as a whole, but each MEMBER is also marked so
-- that: the same registered people actually perform, the minimum squad size is
-- met, absentees are excluded from certificates/trophies, and a replacement can
-- be recorded as a substitute. attendance_status: NULL = not marked yet.
-- Additive + idempotent — safe on live data. team_members already has
-- is_substitute / approved_by / attendance_confirmed from earlier migrations.
-- ============================================================================

ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS attendance_status TEXT
  CHECK (attendance_status IS NULL OR attendance_status IN ('present','absent'));

COMMENT ON COLUMN team_members.attendance_status IS 'Event-day attendance for this team member: present | absent | NULL (not marked). Absentees are excluded from certificates/trophies.';

-- Verify
SELECT 'team_members.attendance_status' AS check,
       COUNT(*) FILTER (WHERE attendance_status = 'present')::text AS present,
       COUNT(*) FILTER (WHERE attendance_status = 'absent')::text  AS absent
FROM team_members;

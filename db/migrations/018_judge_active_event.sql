-- ============================================================================
-- Migration 018 — Judge "active event" focus
-- When the admin sends an event's briefing OTPs, that event becomes the judge's
-- active event, and the judge portal shows ONLY that event (so a judge can't
-- accidentally open/score the wrong event). Cleared/overwritten by the next
-- event's OTP send. NULL = show all assigned events.
-- Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE judges
  ADD COLUMN IF NOT EXISTS active_event_id INT REFERENCES events(id) ON DELETE SET NULL;

COMMENT ON COLUMN judges.active_event_id IS 'Set to the event whose OTP was last sent to this judge; the judge portal focuses on it. NULL = all assigned events.';

COMMIT;

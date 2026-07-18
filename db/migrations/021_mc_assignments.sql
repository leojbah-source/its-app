-- ============================================================================
-- Migration 021 — mc_assignments (which MC covers which event)
-- Mirrors timer_assignments. Role is enforced at the app layer (the assign
-- endpoint checks the user holds the 'MC' role). Separate file from 020 because
-- it USES the 'MC' value, which must be committed first.
-- Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS mc_assignments (
    id            SERIAL PRIMARY KEY,
    user_id       INT NOT NULL REFERENCES users(id),
    event_id      INT NOT NULL REFERENCES events(id),
    year_id       INT NOT NULL REFERENCES year_config(id),
    assigned_by   INT REFERENCES users(id),
    assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_mc_assignments_event ON mc_assignments(event_id);
CREATE INDEX IF NOT EXISTS idx_mc_assignments_user ON mc_assignments(user_id);

COMMENT ON TABLE mc_assignments IS 'Assigns an MC-role user to an event. The MC portal shows only their assigned events.';

COMMIT;

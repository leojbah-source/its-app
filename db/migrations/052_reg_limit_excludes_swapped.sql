-- ============================================================================
-- Migration 052 — Event-cap trigger must not count switched-out entries
-- When the office switches a cancelled entry to another event, the old
-- registration is retired with status = 'swapped' and a new one is inserted.
-- The BEFORE INSERT cap trigger counted every row except 'withdrawn', so the
-- just-swapped row still counted and a full child (e.g. 12/12) wrongly tripped
-- "… has already selected the maximum of N events" during the switch.
-- Fix: count only LIVE entries — status NOT IN ('withdrawn','swapped') —
-- matching how live registrations are counted everywhere else in the app.
-- Idempotent: CREATE OR REPLACE.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_check_registration_limits() RETURNS TRIGGER AS $$
DECLARE
    v_max_events INT;
    v_event_count INT;
    v_name TEXT;
BEGIN
    IF NEW.participant_id IS NULL THEN
        RETURN NEW; -- team registrations are not subject to per-participant caps
    END IF;

    SELECT max_individual_events INTO v_max_events
    FROM year_config WHERE id = NEW.year_id;

    SELECT count(*) INTO v_event_count
    FROM registrations
    WHERE participant_id = NEW.participant_id
      AND year_id = NEW.year_id
      AND status NOT IN ('withdrawn', 'swapped');

    IF v_event_count >= v_max_events THEN
        SELECT full_name INTO v_name FROM participants WHERE id = NEW.participant_id;
        RAISE EXCEPTION '% has already selected the maximum of % events',
            COALESCE(v_name, 'This participant'), v_max_events;
    END IF;

    -- NOTE: no per-category limit here. category_cap applies only in the
    -- awards engine (top-N results per category count towards championships).
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

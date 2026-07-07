-- ============================================================================
-- Migration 005 — Category cap is an AWARDS rule, not a registration rule
-- Blueprint §6.12: year_config.category_cap limits how many results from one
-- category COUNT TOWARDS Kalathilakam / Kalaprathibha / Group Championship
-- points. It does NOT limit how many events a child may enter — only
-- max_individual_events does that. This replaces the registration trigger
-- accordingly, and makes the error message parent-readable (child's name,
-- not internal participant id).
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
      AND status <> 'withdrawn';

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

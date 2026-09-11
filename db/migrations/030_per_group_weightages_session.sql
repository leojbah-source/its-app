-- ============================================================================
-- Migration 030 — per-(event, age group) weightages + judge session expiry
--
--  1) event_criteria_weightages: a per-age-group OVERRIDE of the criteria
--     weightage values (max_score) and the C1..Cn order (sequence_order).
--     event_criteria stays the event-level definition (criterion names +
--     default weightages). When a group's judges adjust the weightages on the
--     briefing screen, an override row is written here for that (event, age
--     group); judging + results use the override when present, else the event
--     default. scores.criterion_id still points at event_criteria(id) — the
--     criterion identity is unchanged, only its weightage / order varies per
--     age group. This lets different age groups of one event (often on
--     different days, with different judges) use different weightages.
--
--  2) judges.active_session_at: when the current single-session login began, so
--     a stale session (tablet closed without sign-out) frees itself after the
--     login window and a fresh OTP login is allowed again.
--
-- Idempotent.
-- ============================================================================

BEGIN;

-- ── 1) Per-age-group criteria weightage overrides ───────────────────────────
CREATE TABLE IF NOT EXISTS event_criteria_weightages (
    event_id        INT NOT NULL REFERENCES events(id)         ON DELETE CASCADE,
    age_group_id    INT NOT NULL REFERENCES age_groups(id)     ON DELETE CASCADE,
    criterion_id    INT NOT NULL REFERENCES event_criteria(id) ON DELETE CASCADE,
    max_score       NUMERIC(5,2) NOT NULL CHECK (max_score > 0),
    sequence_order  INT NOT NULL DEFAULT 1,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, age_group_id, criterion_id)
);

-- One C1..Cn ordering per (event, age group).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ecw_group_sequence
    ON event_criteria_weightages(event_id, age_group_id, sequence_order);

COMMENT ON TABLE event_criteria_weightages IS
  'Per-(event, age group) override of event_criteria weightage (max_score) and C1..Cn order (sequence_order). Absent -> the event_criteria default applies. Values sum to 100 per age group -- enforced by trg_ecw_check.';

-- Sum <= 100 and <= 6 rows per (event, age group). Mirrors fn_check_event_criteria
-- (the app enforces exactly 100; the trigger guards the ceiling so a multi-row
-- transaction can build the set up to the total).
CREATE OR REPLACE FUNCTION fn_check_ecw_sum() RETURNS TRIGGER AS $$
DECLARE
    v_event INT := COALESCE(NEW.event_id, OLD.event_id);
    v_ag    INT := COALESCE(NEW.age_group_id, OLD.age_group_id);
    v_count INT;
    v_sum   NUMERIC;
BEGIN
    SELECT count(*), COALESCE(sum(max_score), 0) INTO v_count, v_sum
    FROM event_criteria_weightages WHERE event_id = v_event AND age_group_id = v_ag;

    IF v_count > 6 THEN
        RAISE EXCEPTION 'Event % age group % cannot have more than 6 criteria weightages', v_event, v_ag;
    END IF;
    IF v_sum > 100 THEN
        RAISE EXCEPTION 'Event % age group % weightages sum to % -- must not exceed 100', v_event, v_ag, v_sum;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ecw_check ON event_criteria_weightages;
CREATE TRIGGER trg_ecw_check
    AFTER INSERT OR UPDATE OR DELETE ON event_criteria_weightages
    FOR EACH ROW EXECUTE FUNCTION fn_check_ecw_sum();

-- The score cap must now honour a per-age-group weightage override when one
-- exists (a group may weight a criterion higher than the event default).
CREATE OR REPLACE FUNCTION fn_check_score_max() RETURNS TRIGGER AS $$
DECLARE
    v_max NUMERIC;
BEGIN
    SELECT COALESCE(w.max_score, ec.max_score) INTO v_max
    FROM event_criteria ec
    LEFT JOIN registrations r ON r.id = NEW.registration_id
    LEFT JOIN event_criteria_weightages w
      ON w.criterion_id = ec.id AND w.event_id = ec.event_id AND w.age_group_id = r.age_group_id
    WHERE ec.id = NEW.criterion_id;

    IF v_max IS NOT NULL AND NEW.score_value > v_max THEN
        RAISE EXCEPTION 'Score % exceeds criterion max_score % (criterion_id=%)', NEW.score_value, v_max, NEW.criterion_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 2) Judge single-session expiry ──────────────────────────────────────────
-- active_session (TEXT) already exists (migration 029). Record WHEN it started
-- so a stale session frees itself after the login window (see auth.routes
-- verify-otp) and admins can reset it manually from the Judges page.
ALTER TABLE judges ADD COLUMN IF NOT EXISTS active_session_at TIMESTAMPTZ;
COMMENT ON COLUMN judges.active_session_at IS
  'When the current active_session began. A new login is blocked while a session is active and newer than the lock window; a stale one past the window is replaced. NULL = no active session.';

COMMIT;

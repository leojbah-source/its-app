-- Migration 067 — whole-group (event × age-group) timer for NON-STAGE written
-- events (Essay, Spelling, Drawing, …). Unlike participant_timings (one row per
-- performer on stage), this is ONE countdown for the whole group: the office
-- starts it when the subject/paper is given; it ends automatically after the
-- event's allotted time. Chest numbers are independent — the timer can start
-- before or after chests are assigned. Idempotent.
CREATE TABLE IF NOT EXISTS event_group_timers (
  id               SERIAL PRIMARY KEY,
  year_id          INT NOT NULL REFERENCES year_config(id),
  event_id         INT NOT NULL REFERENCES events(id),
  age_group_id     INT NOT NULL REFERENCES age_groups(id),
  duration_seconds INT NOT NULL,                 -- snapshot of the allotted time at start
  started_at       TIMESTAMPTZ,                  -- when the office started it
  ends_at          TIMESTAMPTZ,                  -- started_at + duration (+ any extensions)
  ended_at         TIMESTAMPTZ,                  -- set only when stopped EARLY by the office
  started_by       INT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, age_group_id)
);

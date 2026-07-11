-- ============================================================================
-- Migration 013 — Venues / facility setup for scheduling
-- Up to 4 venues per year (enforced in the app). Each has:
--   has_stage      — stage available (needed for stage events)
--   capacity       — max participants accommodated (e.g. tables/chairs for
--                    drawing & painting); NULL = unlimited
--   suitable_for   — {dance,music,arts,literary}; empty array = all events
--   weekday_hours  — availability per weekday, e.g.
--                    {"fri": {"start":"10:00","end":"22:00"},
--                     "mon": {"start":"19:00","end":"22:00"}}
--                    A missing weekday = venue unavailable that day
--                    (e.g. VKL hall off on Wed/Thu simply omits wed/thu).
-- Idempotent: safe to run repeatedly.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS venues (
    id            SERIAL PRIMARY KEY,
    year_id       INT NOT NULL REFERENCES year_config(id),
    name          TEXT NOT NULL,
    has_stage     BOOL NOT NULL DEFAULT TRUE,
    capacity      INT,
    suitable_for  TEXT[] NOT NULL DEFAULT '{}',
    weekday_hours JSONB NOT NULL DEFAULT '{}',
    notes         TEXT,
    sort_order    INT NOT NULL DEFAULT 0,
    UNIQUE (year_id, name)
);

COMMIT;

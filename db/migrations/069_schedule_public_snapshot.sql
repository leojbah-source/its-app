-- Migration 069 — parent-facing PUBLISHED schedule snapshot.
--
-- Problem: both parent views (the public board "Schedule" tab and each child's
-- "My schedule") read the live `schedule` rows (status confirmed/completed), so
-- any staff edit reaches parents instantly. Organisers need to rework the
-- schedule privately (trial and error) and reveal it only when ready.
--
-- Solution: parents read this frozen copy, not the live rows. Staff keep editing
-- the live `schedule`; pressing "Publish schedule to parents" refreshes this
-- copy. Holds only the parent-visible fields of each confirmed/completed row.
-- Column names mirror `schedule` so the read queries just swap their FROM table.
-- When a year has NO snapshot, both endpoints fall back to live `schedule`
-- (so a brand-new year behaves exactly as before this migration).
--
-- Idempotent. The one-time seed runs only while the active year has no snapshot,
-- so a reboot / redeploy is a no-op and never clobbers an in-progress revision.

CREATE TABLE IF NOT EXISTS schedule_public (
  id            INTEGER PRIMARY KEY,                       -- mirrors schedule.id (stable grouping key)
  year_id       INTEGER NOT NULL REFERENCES year_config(id),
  event_id      INTEGER NOT NULL REFERENCES events(id),
  event_date    DATE,
  start_time    TIME,
  end_time      TIME,
  venue         TEXT,
  age_groups    TEXT,
  group_meta    JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT,
  published_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_schedule_public_year ON schedule_public(year_id);

-- One-time seed for the active year: freeze whatever parents already have so
-- turning this feature on changes nothing for them and nothing leaks before the
-- first manual publish. Skipped on every later boot (NOT EXISTS guard).
INSERT INTO schedule_public (id, year_id, event_id, event_date, start_time, end_time,
                             venue, age_groups, group_meta, status, published_at)
SELECT s.id, s.year_id, s.event_id, s.event_date, s.start_time, s.end_time,
       s.venue, s.age_groups, s.group_meta, s.status, now()
FROM schedule s
JOIN year_config yc ON yc.id = s.year_id AND yc.is_active = TRUE
WHERE s.status IN ('confirmed','completed')
  AND NOT EXISTS (SELECT 1 FROM schedule_public sp WHERE sp.year_id = s.year_id);

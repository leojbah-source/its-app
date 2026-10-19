-- Migration 060 — allow the schedule-email log to record team entries too.
ALTER TABLE schedule_email_log ADD COLUMN IF NOT EXISTS team_id INT REFERENCES teams(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_sched_email_log_team ON schedule_email_log (year_id, team_id, status);

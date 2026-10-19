-- Migration 059 — per-recipient log of the "email schedule to parents" sends,
-- so we can see who was sent / who failed (and why) and resend only the rest.
CREATE TABLE IF NOT EXISTS schedule_email_log (
  id             SERIAL PRIMARY KEY,
  year_id        INT REFERENCES year_config(id) ON DELETE CASCADE,
  participant_id INT REFERENCES participants(id) ON DELETE CASCADE,
  email          TEXT,
  status         TEXT NOT NULL,              -- 'sent' | 'failed'
  error          TEXT,
  sent_by        INT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sched_email_log_year ON schedule_email_log (year_id, participant_id, status);

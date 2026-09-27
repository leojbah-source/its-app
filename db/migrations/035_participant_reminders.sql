-- Track follow-up reminders sent to parents with incomplete registrations.
ALTER TABLE participants ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS reminder_count INT NOT NULL DEFAULT 0;

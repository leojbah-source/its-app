-- Track when a consolidation action's affected parents were notified, so the
-- batch "Send notifications" step never messages the same change twice.
ALTER TABLE event_consolidations ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
ALTER TABLE event_consolidations ADD COLUMN IF NOT EXISTS notified_by INTEGER REFERENCES users(id);

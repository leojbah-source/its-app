-- Migration 066 — per-group metadata on a schedule row:
--   group_meta = { "<group code>": { "reporting": "HH:MM", "done": true } }
-- "reporting" overrides the auto-staggered reporting time for that group (so
-- groups like Fancy Dress can be spaced out); "done" marks that group's
-- performance completed (a tick on the day screen). Idempotent.
ALTER TABLE schedule ADD COLUMN IF NOT EXISTS group_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

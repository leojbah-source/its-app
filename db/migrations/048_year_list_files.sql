-- Migration 048 — published participant-list PDFs for the PWA board.
-- Holds a JSON array of { code, label, url } per age group, populated by the
-- admin "Publish lists to PWA" action, and rendered as the public "Participant
-- Lists" card. Idempotent.
BEGIN;
ALTER TABLE year_config ADD COLUMN IF NOT EXISTS list_files JSONB NOT NULL DEFAULT '[]'::jsonb;
COMMIT;

-- Migration 061 — per-category MC introductions for a judge.
-- Map of category_code -> detailed bio. The MC script uses the entry matching
-- the event's category if present, else falls back to judges.detailed_bio.
ALTER TABLE judges ADD COLUMN IF NOT EXISTS category_bios JSONB NOT NULL DEFAULT '{}'::jsonb;

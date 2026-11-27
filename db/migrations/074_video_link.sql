-- 074_video_link.sql
-- Videographer attaches a share link (e.g. Google Drive) to a video request; parents
-- get a Download button in their portal. Idempotent.
ALTER TABLE video_requests
  ADD COLUMN IF NOT EXISTS video_url      TEXT,
  ADD COLUMN IF NOT EXISTS video_added_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS video_added_by INT REFERENCES users(id);

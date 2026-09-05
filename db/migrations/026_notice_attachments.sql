-- ============================================================================
-- Migration 026 — notice attachments (PDF / image)
-- Lets a notice carry a public file (PDF or JPEG/PNG) in addition to text.
-- attachment_url is a /uploads/... path; attachment_type is 'pdf' or 'image'.
-- Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE notices ADD COLUMN IF NOT EXISTS attachment_url  TEXT;
ALTER TABLE notices ADD COLUMN IF NOT EXISTS attachment_type TEXT;

COMMIT;

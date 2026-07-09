-- ============================================================================
-- Migration 008 — Team CPR documents
-- Parents upload CPR scans for team members in bulk (often all members in
-- one or two PDFs). Stored per team; KCA verifies manually on receipt.
-- Idempotent: safe to run repeatedly.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS team_documents (
    id            SERIAL PRIMARY KEY,
    team_id       INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    url           TEXT NOT NULL,
    original_name TEXT,
    uploaded_by   INT REFERENCES users(id),
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    verified_by   INT REFERENCES users(id),   -- admin manual check
    verified_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_team_documents_team ON team_documents (team_id);

COMMIT;

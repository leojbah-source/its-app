-- ============================================================================
-- Migration 022 — notices (public board announcements)
-- Backs GET /api/public/notices and the admin Notices screen. is_active gates
-- public visibility. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS notices (
    id          SERIAL PRIMARY KEY,
    year_id     INT NOT NULL REFERENCES year_config(id),
    title       TEXT NOT NULL,
    body        TEXT,
    is_active   BOOL NOT NULL DEFAULT TRUE,
    posted_by   INT REFERENCES users(id),
    posted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notices_year_active ON notices(year_id, is_active);

COMMENT ON TABLE notices IS 'Public announcements shown on the public board (/pwa). is_active = visible to the public.';

COMMIT;

-- ============================================================================
-- Migration 055 — ensure the disqualification / score-void columns exist.
-- These are defined in schema.sql (sections 14.4 / 14.5) but a prod database
-- built purely from migrations might not have them. The Chairman's
-- disqualify / reinstate workflow depends on them, so assert them here.
-- Fully idempotent (ADD COLUMN IF NOT EXISTS + guarded CHECK constraints).
-- ============================================================================

BEGIN;

ALTER TABLE event_results ADD COLUMN IF NOT EXISTS is_disqualified         BOOL NOT NULL DEFAULT FALSE;
ALTER TABLE event_results ADD COLUMN IF NOT EXISTS disqualification_reason TEXT;
ALTER TABLE event_results ADD COLUMN IF NOT EXISTS disqualified_by         INT REFERENCES users(id);
ALTER TABLE event_results ADD COLUMN IF NOT EXISTS disqualified_at         TIMESTAMPTZ;
ALTER TABLE event_results ADD COLUMN IF NOT EXISTS dq_reversed             BOOL NOT NULL DEFAULT FALSE;
ALTER TABLE event_results ADD COLUMN IF NOT EXISTS dq_reversal_reason      TEXT;
ALTER TABLE event_results ADD COLUMN IF NOT EXISTS dq_reversed_by          INT REFERENCES users(id);
ALTER TABLE event_results ADD COLUMN IF NOT EXISTS dq_reversed_at          TIMESTAMPTZ;

ALTER TABLE scores ADD COLUMN IF NOT EXISTS is_void       BOOL NOT NULL DEFAULT FALSE;
ALTER TABLE scores ADD COLUMN IF NOT EXISTS voided_reason TEXT;
ALTER TABLE scores ADD COLUMN IF NOT EXISTS voided_by     INT REFERENCES users(id);
ALTER TABLE scores ADD COLUMN IF NOT EXISTS voided_at     TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_results_dq_reason_required') THEN
    ALTER TABLE event_results ADD CONSTRAINT event_results_dq_reason_required
      CHECK (NOT is_disqualified OR disqualification_reason IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_results_dq_reversal_reason_required') THEN
    ALTER TABLE event_results ADD CONSTRAINT event_results_dq_reversal_reason_required
      CHECK (NOT dq_reversed OR dq_reversal_reason IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_event_results_dq ON event_results(is_disqualified) WHERE is_disqualified = TRUE;

COMMIT;

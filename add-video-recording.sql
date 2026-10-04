-- ============================================================================
-- ITS 2026 — Video recording add-on (video_fee + video_requests table)
-- ============================================================================
-- Lets coordinators record, on Event Day, which participants want a paid video
-- of their performance and how they paid (cash / BenefitPay); the videographer
-- (Media role) works the opted-in list and ticks each as recorded; collections
-- roll into the Finance summary.
--
-- Additive and idempotent — safe on staging and production live data.
-- Run BEFORE deploying the code that uses it:
--   psql "<External Database URL>?sslmode=require" -f add-video-recording.sql
-- ============================================================================

ALTER TABLE year_config ADD COLUMN IF NOT EXISTS video_fee NUMERIC(6,3) NOT NULL DEFAULT 5.000;

CREATE TABLE IF NOT EXISTS video_requests (
  id              SERIAL PRIMARY KEY,
  year_id         INT NOT NULL REFERENCES year_config(id) ON DELETE CASCADE,
  registration_id INT NOT NULL UNIQUE REFERENCES registrations(id) ON DELETE CASCADE,
  event_id        INT NOT NULL REFERENCES events(id),
  age_group_id    INT REFERENCES age_groups(id),
  amount          NUMERIC(6,3) NOT NULL DEFAULT 5.000,
  payment_method  TEXT NOT NULL CHECK (payment_method IN ('cash','benefitpay')),
  collected_by    INT REFERENCES users(id),
  collected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded        BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_by     INT REFERENCES users(id),
  recorded_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_video_requests_year      ON video_requests(year_id);
CREATE INDEX IF NOT EXISTS idx_video_requests_event     ON video_requests(event_id);
CREATE INDEX IF NOT EXISTS idx_video_requests_eventgrp  ON video_requests(event_id, age_group_id);
CREATE INDEX IF NOT EXISTS idx_video_requests_collector ON video_requests(collected_by);

-- Verify
SELECT 'year_config.video_fee' AS check, video_fee::text AS value FROM year_config WHERE is_active = TRUE
UNION ALL
SELECT 'video_requests rows', COUNT(*)::text FROM video_requests;

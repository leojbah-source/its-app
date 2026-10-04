-- Video recording add-on: parents of dance/team (or any) participants may pay a
-- fee to receive a video of the performance. Opt-in is recorded at reporting
-- time (Event Day) by a coordinator, who also notes how payment was made
-- (cash / BenefitPay). The videographer (Media role) works a live opted-in list
-- and ticks each as recorded. Collections roll into the Finance summary.
-- Additive + idempotent — safe on live data.

-- Per-year video fee (BHD). Amount actually charged is copied onto each request
-- so historical records stay correct even if the fee changes later.
ALTER TABLE year_config ADD COLUMN IF NOT EXISTS video_fee NUMERIC(6,3) NOT NULL DEFAULT 5.000;

CREATE TABLE IF NOT EXISTS video_requests (
  id              SERIAL PRIMARY KEY,
  year_id         INT NOT NULL REFERENCES year_config(id) ON DELETE CASCADE,
  registration_id INT NOT NULL UNIQUE REFERENCES registrations(id) ON DELETE CASCADE,
  event_id        INT NOT NULL REFERENCES events(id),
  age_group_id    INT REFERENCES age_groups(id),
  amount          NUMERIC(6,3) NOT NULL DEFAULT 5.000,
  payment_method  TEXT NOT NULL CHECK (payment_method IN ('cash','benefitpay')),
  collected_by    INT REFERENCES users(id),     -- coordinator who ticked / took the money
  collected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded        BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_by     INT REFERENCES users(id),      -- videographer who filmed it
  recorded_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE video_requests IS 'One row per registration whose performance video was requested (BHD video_fee). Opt-in captured on Event Day; filmed-status ticked by the videographer; amounts feed the Finance summary.';

CREATE INDEX IF NOT EXISTS idx_video_requests_year     ON video_requests(year_id);
CREATE INDEX IF NOT EXISTS idx_video_requests_event    ON video_requests(event_id);
CREATE INDEX IF NOT EXISTS idx_video_requests_eventgrp ON video_requests(event_id, age_group_id);
CREATE INDEX IF NOT EXISTS idx_video_requests_collector ON video_requests(collected_by);

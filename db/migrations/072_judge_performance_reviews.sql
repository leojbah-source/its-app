-- 072_judge_performance_reviews.sql
-- Chairman's per-judge performance rating (/10) and notes, per year. The marking
-- metrics (panel alignment, harsh/lenient, discrimination) are computed on the fly
-- from scores; only the human rating + notes are stored here. Idempotent.
CREATE TABLE IF NOT EXISTS judge_performance_reviews (
  id          SERIAL PRIMARY KEY,
  judge_id    INT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  year_id     INT NOT NULL REFERENCES year_config(id) ON DELETE CASCADE,
  rating      NUMERIC(4,1) CHECK (rating IS NULL OR (rating >= 0 AND rating <= 10)),
  notes       TEXT,
  reviewed_by INT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (judge_id, year_id)
);

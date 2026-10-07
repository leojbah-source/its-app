-- Deferred judging: writing/drawing events (Essay, Handwriting, etc.) are judged
-- later, one judge at a time with the originals, so the on-the-day criteria
-- "agreement" step is not feasible. For such events the Chairman's default
-- criteria marks are fixed for ALL judges and scoring proceeds without an
-- agreement step. Additive + idempotent — safe on live data.
ALTER TABLE events ADD COLUMN IF NOT EXISTS deferred_judging BOOLEAN NOT NULL DEFAULT FALSE;

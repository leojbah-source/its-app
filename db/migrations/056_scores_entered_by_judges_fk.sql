-- ============================================================================
-- Migration 056 — fix scores.entered_by foreign key.
-- Judge scores are entered by a JUDGE (judges.id), but entered_by was
-- constrained to users(id). It only worked when a judge's id happened to
-- coincide with a user id; otherwise inserts failed with
-- "scores_entered_by_fkey" violations. Re-point the FK to judges(id).
-- Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE scores DROP CONSTRAINT IF EXISTS scores_entered_by_fkey;

-- Safety: clear any entered_by that isn't a known judge, so the new FK applies.
UPDATE scores SET entered_by = NULL
 WHERE entered_by IS NOT NULL
   AND entered_by NOT IN (SELECT id FROM judges);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scores_entered_by_judges_fkey') THEN
    ALTER TABLE scores
      ADD CONSTRAINT scores_entered_by_judges_fkey
      FOREIGN KEY (entered_by) REFERENCES judges(id);
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- Migration 025 — in-kind sponsorships on finance_income
-- Some sponsors give goods/services (drinking water, judges' food) rather than
-- cash. We record those as income with kind='in_kind' and an equivalent dinar
-- value in `amount`, plus an `item` description. Cash income keeps kind='cash'.
-- Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE finance_income
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'cash';

-- Constraint added separately so re-runs don't error if it already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'finance_income_kind_chk'
  ) THEN
    ALTER TABLE finance_income
      ADD CONSTRAINT finance_income_kind_chk CHECK (kind IN ('cash', 'in_kind'));
  END IF;
END $$;

ALTER TABLE finance_income
  ADD COLUMN IF NOT EXISTS item TEXT;

COMMENT ON COLUMN finance_income.kind IS 'cash = money received; in_kind = goods/services sponsored, amount holds the equivalent dinar value.';
COMMENT ON COLUMN finance_income.item IS 'For in-kind sponsorships: what was given (e.g. Drinking water, Judges'' food).';

COMMIT;

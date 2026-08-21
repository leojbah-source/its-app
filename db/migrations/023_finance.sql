-- ============================================================================
-- Migration 023 — finance module tables
-- Backs the (already-written) /api/admin/finance routes: income, expenses, and
-- expense heads, all year-scoped. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS finance_expense_heads (
    id          SERIAL PRIMARY KEY,
    year_id     INT NOT NULL REFERENCES year_config(id),
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (year_id, name)
);

CREATE TABLE IF NOT EXISTS finance_income (
    id          SERIAL PRIMARY KEY,
    year_id     INT NOT NULL REFERENCES year_config(id),
    source      TEXT NOT NULL,
    amount      NUMERIC(12,3) NOT NULL CHECK (amount >= 0),
    date        DATE NOT NULL,
    notes       TEXT,
    created_by  INT REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finance_income_year ON finance_income(year_id, date);

CREATE TABLE IF NOT EXISTS finance_expenses (
    id              SERIAL PRIMARY KEY,
    year_id         INT NOT NULL REFERENCES year_config(id),
    expense_head_id INT REFERENCES finance_expense_heads(id),
    amount          NUMERIC(12,3) NOT NULL CHECK (amount >= 0),
    date            DATE NOT NULL,
    vendor          TEXT,
    notes           TEXT,
    created_by      INT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finance_expenses_year ON finance_expenses(year_id, date);
CREATE INDEX IF NOT EXISTS idx_finance_expenses_head ON finance_expenses(expense_head_id);

COMMENT ON TABLE finance_income IS 'Money received (fees, sponsorships, etc.), year-scoped.';
COMMENT ON TABLE finance_expenses IS 'Money spent, categorised by finance_expense_heads, year-scoped.';

COMMIT;

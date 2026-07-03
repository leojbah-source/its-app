-- ============================================================================
-- Migration 001 — Fees, Payments, Refunds & Finance tables
-- Blueprint refs: §4.10 Financial Management, §5.2 fee calculator,
--                 §5.3 post-registration edits, §5.4 payment methods.
-- Idempotent: safe to run repeatedly (IF NOT EXISTS / DO-guard everywhere).
-- Run:  psql -d its_app -f db/migrations/001_fees_payments_finance.sql
-- ============================================================================

BEGIN;

-- ── 1. Fee configuration ────────────────────────────────────────────────────
-- Per-event fees (BHD uses 3 decimal places). Rule 22 fee structure:
--   fee_amount        = standard (non-member) rate, e.g. BD 3 dance, BD 10 team
--   member_fee_amount = KCA-member rate, e.g. BD 2/3/5 (NULL = same as standard)
-- The member rate applies in real time when membership is verified active (§4.3).
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS fee_amount NUMERIC(10,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS member_fee_amount NUMERIC(10,3);

-- ── 2. Payments (§5.4: cash / BenefitPay / bank transfer) ───────────────────
DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('cash','benefitpay','bank_transfer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pending','confirmed','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS payments (
    id               SERIAL PRIMARY KEY,
    year_id          INT NOT NULL REFERENCES year_config(id),
    parent_user_id   INT REFERENCES users(id),        -- parent who submitted
    participant_id   INT REFERENCES participants(id),
    amount           NUMERIC(10,3) NOT NULL CHECK (amount >= 0),
    discount_applied NUMERIC(10,3) NOT NULL DEFAULT 0,
    method           payment_method NOT NULL,
    status           payment_status NOT NULL DEFAULT 'pending',
    reference        TEXT,                            -- BenefitPay / bank ref
    proof_url        TEXT,                            -- uploaded screenshot
    notes            TEXT,
    confirmed_by     INT REFERENCES users(id),
    confirmed_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_year_status ON payments (year_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_participant ON payments (participant_id);

-- Fee charged per registration at time of selection (post-discount snapshot),
-- and the payment that covered it.
ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS fee_amount NUMERIC(10,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_id INT REFERENCES payments(id);

-- ── 3. Refunds (§4.10 Refunds Report, §5.3 removals) ────────────────────────
CREATE TABLE IF NOT EXISTS refunds (
    id               SERIAL PRIMARY KEY,
    year_id          INT NOT NULL REFERENCES year_config(id),
    participant_id   INT NOT NULL REFERENCES participants(id),
    registration_id  INT REFERENCES registrations(id),
    events_withdrawn TEXT,                            -- readable snapshot, e.g. 'NAT01 — Solo Dance'
    reason           TEXT NOT NULL,
    original_amount  NUMERIC(10,3) NOT NULL DEFAULT 0,
    refund_amount    NUMERIC(10,3) NOT NULL DEFAULT 0,
    method           TEXT,                            -- cash / benefitpay / bank_transfer
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),
    refunded_at      DATE,
    requested_by     INT REFERENCES users(id),        -- parent
    logged_by        INT REFERENCES users(id),        -- admin who confirmed
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refunds_year_status ON refunds (year_id, status);

-- ── 4. Finance ledger tables (§4.10) — used by admin.finance.routes.js ──────
CREATE TABLE IF NOT EXISTS finance_expense_heads (
    id         SERIAL PRIMARY KEY,
    year_id    INT NOT NULL REFERENCES year_config(id),
    name       TEXT NOT NULL,
    is_active  BOOL NOT NULL DEFAULT TRUE,
    UNIQUE (year_id, name)
);

CREATE TABLE IF NOT EXISTS finance_income (
    id         SERIAL PRIMARY KEY,
    year_id    INT NOT NULL REFERENCES year_config(id),
    source     TEXT NOT NULL,           -- 'Registration fees', sponsor name, etc.
    amount     NUMERIC(10,3) NOT NULL,
    date       DATE NOT NULL,
    notes      TEXT,
    created_by INT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_expenses (
    id              SERIAL PRIMARY KEY,
    year_id         INT NOT NULL REFERENCES year_config(id),
    expense_head_id INT NOT NULL REFERENCES finance_expense_heads(id),
    amount          NUMERIC(10,3) NOT NULL,
    date            DATE NOT NULL,
    vendor          TEXT,               -- 'paid to'
    notes           TEXT,
    created_by      INT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;

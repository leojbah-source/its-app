-- ============================================================================
-- Migration 002 — Addendum 1: 'Timer' role value
-- Blueprint Addendum 1 §1.1 / §3.1.
-- Everything else in the addendum's schema (participant_timings,
-- timer_assignments, events timing columns, scores.is_void/voided_*,
-- event_results is_disqualified/dq_*) already exists in db/schema.sql
-- (sections 14.4 / 14.5). The only missing piece is the enum value, which
-- schema.sql line ~977 documents but never adds.
-- Idempotent: safe to run repeatedly.
-- ============================================================================

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'Timer';

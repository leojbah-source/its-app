-- ============================================================================
-- Migration 057 — judges agree the combined result before publishing.
-- Each assigned judge may explicitly agree the finalised ranking of a group.
-- The Chairman's Publish is gated on all judges having agreed (with override).
-- Idempotent.
-- ============================================================================
ALTER TABLE judge_assignments ADD COLUMN IF NOT EXISTS result_agreed_at TIMESTAMPTZ;

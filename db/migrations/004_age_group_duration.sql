-- ============================================================================
-- Migration 004 — Per-age-group event duration override
-- The event-level allotted_time_seconds applies by default; when an event
-- spans multiple age groups (e.g. juniors get less stage time), a per-group
-- override can be stored on the junction row.
-- Idempotent: safe to run repeatedly.
-- ============================================================================

ALTER TABLE event_age_groups
  ADD COLUMN IF NOT EXISTS allotted_time_seconds INT;

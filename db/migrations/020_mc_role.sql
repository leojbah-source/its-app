-- ============================================================================
-- Migration 020 — 'MC' user role
-- MCs (emcees) are staff accounts with the MC role, assigned per event, who see
-- their event's MC script (with judge bios) and the participant list on the day.
-- NOTE: ALTER TYPE ... ADD VALUE must be its OWN statement (cannot run inside a
-- transaction block with other statements) — mirrors migration 002 for Timer.
-- Idempotent: safe to run repeatedly.
-- ============================================================================

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'MC';

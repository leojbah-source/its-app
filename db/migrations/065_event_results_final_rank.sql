-- Migration 065 — store the overall finishing rank (1..N), not just the prize
-- place, so the public board can show and order by every participant's rank.
ALTER TABLE event_results ADD COLUMN IF NOT EXISTS final_rank INT;

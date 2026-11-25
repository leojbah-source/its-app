-- 071_fix_additional_3rd_rank_points.sql
-- One-time, idempotent correction of stored rank points for "Additional 3rd" prizes.
--
-- An Additional 3rd is a FULL 3rd place and earns 3rd-place rank points (see
-- computeGroup in backend/src/routes/admin.judging.routes.js). Earlier, extra
-- prizes were treated as carrying no rank points, so Additional 3rds that were
-- PUBLISHED under the old rule were stored with rank_points = 0. The publish step
-- never rewrites a published row (persistResults ... WHERE is_published = FALSE),
-- so those stored totals stayed low and the participant portal (which shows the
-- stored published figure) under-counted them -- even though the live admin result
-- sheet recomputes and shows the correct total.
--
-- Fix: set rank_points to the event's own year 3rd-place value for every
-- additional_3rd result whose stored value is wrong. total_points is a GENERATED
-- column (rank_points + grade_points + participation_bonus_pts) and recomputes
-- automatically. Only rank_points is touched -- prize_place, grade, grade_points
-- and everything else are left exactly as they are.
--
-- Idempotent: the guard matches only rows that are still wrong, so re-running on
-- every boot is a no-op once corrected.
UPDATE event_results er
SET rank_points = yc.rank_pts_third
FROM events e
JOIN year_config yc ON yc.id = e.year_id
WHERE er.event_id = e.id
  AND er.extra_prize_type = 'additional_3rd'
  AND er.rank_points IS DISTINCT FROM yc.rank_pts_third;

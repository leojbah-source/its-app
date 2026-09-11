-- ============================================================================
-- Migration 031 — participation points count for SCHOOL AWARDS only
--
-- Decision (Leo, Sept 2026): the participation bonus must NOT be added to a
-- participant's own points. It is used ONLY to compute the school awards.
--
-- So the individual competitive total (event_results.total_points — shown on the
-- result sheet, the participant's "My Results", teacher awards and group
-- championship) becomes rank_points + grade_points, WITHOUT participation.
-- participation_bonus_pts stays a stored column and is added back ONLY in the
-- school-award aggregate (v_school_award_totals, rule #16).
--
-- The two award views depend on total_points, so they are dropped and recreated
-- around the column change. Idempotent (safe to re-run).
-- ============================================================================

BEGIN;

-- Views depend on total_points — drop before altering the column.
DROP VIEW IF EXISTS v_group_championship;
DROP VIEW IF EXISTS v_school_award_totals;

-- Individual total = rank + grade (participation removed).
ALTER TABLE event_results DROP COLUMN IF EXISTS total_points;
ALTER TABLE event_results
  ADD COLUMN total_points NUMERIC(6,2)
  GENERATED ALWAYS AS (rank_points + grade_points) STORED;
COMMENT ON COLUMN event_results.total_points IS
  'Participant competitive total = rank_points + grade_points. Participation bonus is NOT included (it feeds the school award only — see v_school_award_totals).';

-- School awards (rule #16): STILL include participation. grand_total sums the
-- three component columns directly, so it is independent of total_points.
CREATE VIEW v_school_award_totals AS
SELECT
    p.year_id,
    p.school_id,
    s.name AS school_name,
    SUM(er.rank_points)                                               AS total_rank_points,
    SUM(er.grade_points)                                             AS total_grade_points,
    SUM(er.participation_bonus_pts)                                  AS total_participation_pts,
    SUM(er.rank_points + er.grade_points + er.participation_bonus_pts) AS grand_total
FROM event_results er
JOIN registrations r  ON r.id = er.registration_id
JOIN participants p   ON p.id = r.participant_id
JOIN schools s        ON s.id = p.school_id
WHERE er.is_finalised = TRUE
GROUP BY p.year_id, p.school_id, s.name;

-- Group championship (rule #15): follows the participant total (now rank + grade,
-- participation excluded — consistent with "participation only for school awards").
CREATE VIEW v_group_championship AS
SELECT
    t.year_id,
    t.age_group_id,
    ag.label AS age_group_label,
    t.school_id,
    s.name   AS school_name,
    SUM(er.total_points) AS total_points
FROM event_results er
JOIN registrations r ON r.id = er.registration_id
JOIN teams t          ON t.id = r.team_id
JOIN age_groups ag    ON ag.id = t.age_group_id
JOIN schools s        ON s.id = t.school_id
WHERE er.is_finalised = TRUE
GROUP BY t.year_id, t.age_group_id, ag.label, t.school_id, s.name;

COMMIT;

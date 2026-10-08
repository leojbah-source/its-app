-- ============================================================================
-- Migration 047 — Team events are ONE contest per event (base-group bucket)
-- ============================================================================
-- A team event (e.g. Cinematic Dance Juniors / Seniors) is a single contest:
-- all its teams are judged together and get one set of winners. The system
-- runs contests per (event, age_group), so every team in a team event is
-- bucketed under that event's BASE age group (lowest sort_order of the event's
-- eligible groups) regardless of members' own groups. Juniors and Seniors are
-- different EVENTS, so they remain separate contests.
-- Idempotent (only rewrites mismatches); safe to run repeatedly. No team
-- judging has started yet, so re-bucketing is safe.
-- ============================================================================

WITH base AS (
  SELECT e.id AS event_id,
         (SELECT ag.id FROM event_age_groups eag JOIN age_groups ag ON ag.id = eag.age_group_id
          WHERE eag.event_id = e.id ORDER BY ag.sort_order LIMIT 1) AS ag_id
  FROM events e WHERE e.event_kind = 'team'
)
UPDATE registrations r
   SET age_group_id = base.ag_id, updated_at = now()
  FROM base
 WHERE r.event_id = base.event_id
   AND r.team_id IS NOT NULL
   AND base.ag_id IS NOT NULL
   AND r.age_group_id IS DISTINCT FROM base.ag_id;

WITH base AS (
  SELECT e.id AS event_id,
         (SELECT ag.id FROM event_age_groups eag JOIN age_groups ag ON ag.id = eag.age_group_id
          WHERE eag.event_id = e.id ORDER BY ag.sort_order LIMIT 1) AS ag_id
  FROM events e WHERE e.event_kind = 'team'
)
UPDATE teams t
   SET age_group_id = base.ag_id
  FROM base
 WHERE t.event_id = base.event_id
   AND base.ag_id IS NOT NULL
   AND t.age_group_id IS DISTINCT FROM base.ag_id;

-- Verify: each team event should now show exactly ONE distinct age group.
SELECT e.event_code, COUNT(DISTINCT r.age_group_id) AS distinct_groups, COUNT(*) AS team_entries
FROM registrations r JOIN events e ON e.id = r.event_id
WHERE e.event_kind = 'team' AND r.team_id IS NOT NULL
GROUP BY e.event_code
ORDER BY e.event_code;

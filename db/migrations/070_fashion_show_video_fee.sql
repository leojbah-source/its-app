-- Migration 070 — Fashion Show video fee is BHD 3 (a ~3-minute event), not the
-- standard BHD 5 used for dance/team. New opt-ins are charged 3 by the app;
-- this corrects Fashion Show video opt-ins that are still at the standard BHD 5
-- (the wrong fee) down to 3.000 so the Finance summary reflects the correct fee.
-- IMPORTANT: it matches ONLY the standard 5.000 value, never other amounts, so a
-- coordinator's edited/discounted amount (e.g. a sibling discount) is NEVER reset
-- when the app reboots. Once corrected there are no 5.000 rows left, so re-runs
-- are a no-op.
UPDATE video_requests vr
   SET amount = 3.000, updated_at = now()
  FROM events e
 WHERE e.id = vr.event_id
   AND e.event_name ILIKE '%fashion%'
   AND vr.amount = 5.000;

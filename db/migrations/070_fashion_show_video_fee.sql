-- Migration 070 — Fashion Show video fee is BHD 3 (a ~3-minute event), not the
-- standard BHD 5 used for dance/team. New opt-ins are charged 3 by the app;
-- this corrects any ALREADY-recorded Fashion Show video opt-ins to 3.000 so the
-- Finance summary reflects the correct fee. Idempotent (skips rows already 3).
UPDATE video_requests vr
   SET amount = 3.000, updated_at = now()
  FROM events e
 WHERE e.id = vr.event_id
   AND e.event_name ILIKE '%fashion%'
   AND vr.amount <> 3.000;

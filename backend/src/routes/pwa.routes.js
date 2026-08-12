// src/routes/pwa.routes.js  (mounted at /api/pwa, requires pwa-login JWT)
// Rule #21: PWA login via name_prefix+cpr_suffix (see auth.routes.js).
// Rule #22: Chest numbers must NEVER be shown in the PWA, anywhere.
// Rule #23: My Results = event name, grade, rank pts, grade pts per event + running totals.
const express = require('express');
const pool = require('../db');
const { authenticate, requireType } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireType('pwa'));

// GET /api/pwa/my-schedule — this participant's personal events, NO chest numbers (rule #22)
router.get('/my-schedule', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.event_name, c.name AS category, (e.event_kind = 'team') AS is_team_event,
              ag.label AS age_group,
              s.venue, s.event_date, s.start_time, s.end_time, ts.slot_label
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       LEFT JOIN categories c ON c.id = e.category_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       LEFT JOIN LATERAL (
         SELECT venue, event_date, start_time, end_time, time_slot_id
         FROM schedule sd
         WHERE sd.event_id = r.event_id AND sd.year_id = r.year_id
           AND sd.status IN ('confirmed','completed')
         ORDER BY sd.event_date, sd.start_time LIMIT 1
       ) s ON TRUE
       LEFT JOIN event_time_slots ts ON ts.id = s.time_slot_id
       WHERE r.participant_id = $1 AND r.status NOT IN ('withdrawn','swapped')
       ORDER BY s.event_date NULLS LAST, s.start_time NULLS LAST, e.event_name`,
      [req.user.participantId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/pwa/my-results — per event: grade, rank pts, grade pts + running totals (rule #23)
router.get('/my-results', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.event_name, c.name AS category, ag.label AS age_group,
              er.prize_place, er.grade, er.rank_points, er.grade_points,
              er.participation_bonus_pts, er.total_points, er.extra_prize_type
       FROM event_results er
       JOIN registrations r ON r.id = er.registration_id
       JOIN events e ON e.id = er.event_id
       LEFT JOIN categories c ON c.id = e.category_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       WHERE r.participant_id = $1 AND er.is_published = TRUE
       ORDER BY e.event_name`,
      [req.user.participantId]
    );

    const totals = rows.reduce(
      (acc, r) => ({
        rank_points: acc.rank_points + Number(r.rank_points || 0),
        grade_points: acc.grade_points + Number(r.grade_points || 0),
        participation_bonus_pts: acc.participation_bonus_pts + Number(r.participation_bonus_pts || 0),
        total_points: acc.total_points + Number(r.total_points || 0),
      }),
      { rank_points: 0, grade_points: 0, participation_bonus_pts: 0, total_points: 0 }
    );

    res.json({ results: rows, totals });
  } catch (err) { next(err); }
});

module.exports = router;

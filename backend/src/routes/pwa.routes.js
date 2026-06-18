// src/routes/pwa.routes.js  (mounted at /api/pwa, requires pwa-login JWT)
// Rule #21: PWA login via name_prefix+cpr_suffix (see auth.routes.js).
// Rule #22: Chest numbers must NEVER be shown in the PWA, anywhere.
// Rule #23: My Results = event name, grade, rank pts, grade pts per event + running totals.
const express = require('express');
const pool = require('../db');
const { authenticate, requireType } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireType('pwa'));

// GET /api/pwa/my-schedule  -- this participant's personal events, NO chest numbers (rule #22)
router.get('/my-schedule', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.name AS event_name, e.category, e.is_team_event,
              sd.venue, ts.slot_label, ts.start_time, ts.end_time
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       LEFT JOIN schedule_draft sd ON sd.event_id = e.id AND sd.status = 'published'
       LEFT JOIN time_slots ts ON ts.id = sd.time_slot_id
       WHERE r.child_id = $1 AND r.status != 'cancelled'
       ORDER BY ts.start_time NULLS LAST, e.name`,
      [req.user.childId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/pwa/my-results  -- event name, grade, rank pts, grade pts per event + running totals (rule #23)
router.get('/my-results', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.name AS event_name, res.grade, res.rank_points, res.grade_points
       FROM results res
       JOIN registrations r ON r.id = res.registration_id
       JOIN events e ON e.id = res.event_id
       WHERE r.child_id = $1 AND res.is_published = true
       ORDER BY e.name`,
      [req.user.childId]
    );

    const totals = rows.reduce(
      (acc, r) => ({
        totalRankPoints: acc.totalRankPoints + Number(r.rank_points || 0),
        totalGradePoints: acc.totalGradePoints + Number(r.grade_points || 0),
      }),
      { totalRankPoints: 0, totalGradePoints: 0 }
    );

    res.json({
      results: rows,
      totals: {
        ...totals,
        grandTotal: totals.totalRankPoints + totals.totalGradePoints,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

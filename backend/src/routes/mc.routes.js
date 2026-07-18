// src/routes/mc.routes.js  (mounted at /api/mc)
// MC portal (staff login, MC role). MC script auto-fills the 3 judges' bios,
// event details, criteria and timing; participants shown by chest number WITH
// names (MCs announce names), in chest order per group.
const express = require('express');
const pool = require('../db');
const { authenticate, requireType } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireType('staff'));
router.use((req, res, next) => {
  if (['MC', 'SuperAdmin', 'Chairman'].includes(req.user.role)) return next();
  return res.status(403).json({ error: 'MC access only' });
});

// GET /my-events — the MC's assigned events
router.get('/my-events', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ma.event_id, e.event_code, e.event_name, c.name AS category_name
       FROM mc_assignments ma JOIN events e ON e.id = ma.event_id
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE ma.user_id = $1 ORDER BY e.event_code`, [req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /script/:event_id — MC script data (judges' bios auto-included)
router.get('/script/:event_id', async (req, res, next) => {
  try {
    const { rows: ev } = await pool.query(
      `SELECT e.id, e.event_code, e.event_name, e.is_stage_event,
              e.allotted_time_seconds, e.grace_period_seconds, e.yellow_alert_seconds,
              c.name AS category_name
       FROM events e LEFT JOIN categories c ON c.id = e.category_id WHERE e.id = $1`, [req.params.event_id]);
    if (!ev[0]) return res.status(404).json({ error: 'Event not found' });
    const { rows: judges } = await pool.query(
      `SELECT j.full_name, j.detailed_bio, j.bio, j.expertise
       FROM judge_assignments ja JOIN judges j ON j.id = ja.judge_id
       WHERE ja.event_id = $1 ORDER BY j.full_name`, [req.params.event_id]);
    const { rows: criteria } = await pool.query(
      `SELECT criterion_name AS label, max_score, sequence_order
       FROM event_criteria WHERE event_id = $1 ORDER BY sequence_order, id`, [req.params.event_id]);
    const { rows: sched } = await pool.query(
      `SELECT to_char(MIN(event_date), 'YYYY-MM-DD') AS date, to_char(MIN(start_time), 'HH24:MI') AS start,
              string_agg(DISTINCT venue, ', ') AS venue
       FROM schedule WHERE event_id = $1`, [req.params.event_id]);
    const { rows: yc } = await pool.query(
      `SELECT event_year_label, sponsor_name FROM year_config WHERE is_active = TRUE LIMIT 1`);
    res.json({ event: ev[0], judges, criteria, schedule: sched[0] || {}, year: yc[0] || {} });
  } catch (err) { next(err); }
});

// GET /participants/:event_id — chest + NAME, by group, chest order
router.get('/participants/:event_id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ag.code AS age_group, ag.sort_order, ca.chest_number,
              COALESCE(p.full_name, t.team_name) AS name,
              (pt.end_time IS NOT NULL) AS done
       FROM registrations r JOIN chest_assignments ca ON ca.registration_id = r.id
       JOIN age_groups ag ON ag.id = r.age_group_id
       LEFT JOIN participants p ON p.id = r.participant_id
       LEFT JOIN teams t ON t.id = r.team_id
       LEFT JOIN LATERAL (SELECT end_time FROM participant_timings t2
                          WHERE t2.registration_id = r.id AND t2.event_id = $1
                          ORDER BY t2.id DESC LIMIT 1) pt ON TRUE
       WHERE r.event_id = $1 AND r.status = 'attended'
       ORDER BY ag.sort_order, ca.chest_number`, [req.params.event_id]);
    const groups = []; const map = new Map();
    for (const row of rows) {
      if (!map.has(row.age_group)) { const g = { age_group: row.age_group, participants: [] }; map.set(row.age_group, g); groups.push(g); }
      map.get(row.age_group).participants.push({ chest_number: row.chest_number, name: row.name, done: row.done });
    }
    res.json(groups);
  } catch (err) { next(err); }
});

module.exports = router;

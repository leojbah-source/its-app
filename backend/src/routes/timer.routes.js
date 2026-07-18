// src/routes/timer.routes.js  (mounted at /api/timer)
// Timer portal (staff Timer role). Sees CHEST NUMBERS ONLY (no names). Records
// start/stop into participant_timings (generated columns compute time/DQ; a
// BEFORE-INSERT trigger fills allotted/grace snapshots). Only a Chairman (email
// + password) may override a timing (e.g. a missed stop).
const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { authenticate, requireType } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate, requireType('staff'));
router.use((req, res, next) => {
  if (['Timer', 'SuperAdmin', 'Chairman'].includes(req.user.role)) return next();
  return res.status(403).json({ error: 'Timer access only' });
});

async function latestTiming(reg, event) {
  const { rows } = await pool.query(
    `SELECT * FROM participant_timings WHERE registration_id = $1 AND event_id = $2 ORDER BY id DESC LIMIT 1`, [reg, event]);
  return rows[0] || null;
}

// GET /my-events — the Timer's assigned events
router.get('/my-events', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ta.event_id, e.event_code, e.event_name, c.name AS category_name,
              e.allotted_time_seconds, e.grace_period_seconds, e.yellow_alert_seconds
       FROM timer_assignments ta JOIN events e ON e.id = ta.event_id
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE ta.user_id = $1 ORDER BY e.event_code`, [req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /participants/:event_id — CHEST ONLY + timing state + event thresholds
router.get('/participants/:event_id', async (req, res, next) => {
  try {
    const { rows: ev } = await pool.query(
      `SELECT allotted_time_seconds, grace_period_seconds, yellow_alert_seconds FROM events WHERE id = $1`, [req.params.event_id]);
    if (!ev[0]) return res.status(404).json({ error: 'Event not found' });
    const { rows } = await pool.query(
      `SELECT r.id AS registration_id, ca.chest_number, ag.code AS age_group, ag.sort_order,
              pt.start_time, pt.end_time, pt.time_taken_seconds, pt.flag_for_dq
       FROM registrations r JOIN chest_assignments ca ON ca.registration_id = r.id
       JOIN age_groups ag ON ag.id = r.age_group_id
       LEFT JOIN LATERAL (SELECT start_time, end_time, time_taken_seconds, flag_for_dq
                          FROM participant_timings t WHERE t.registration_id = r.id AND t.event_id = $1
                          ORDER BY t.id DESC LIMIT 1) pt ON TRUE
       WHERE r.event_id = $1 AND r.status = 'attended'
       ORDER BY ag.sort_order, ca.chest_number`, [req.params.event_id]);
    res.json({ timing: ev[0], participants: rows });
  } catch (err) { next(err); }
});

// POST /:event_id/start — { registration_id, chest_number }
router.post('/:event_id/start', async (req, res, next) => {
  try {
    const { registration_id, chest_number } = req.body;
    if (!registration_id) return res.status(400).json({ error: 'registration_id required' });
    const ex = await latestTiming(registration_id, req.params.event_id);
    if (ex) {
      const { rows } = await pool.query(
        `UPDATE participant_timings SET start_time = NOW(), end_time = NULL, timed_by = $1 WHERE id = $2 RETURNING *`,
        [req.user.id, ex.id]);
      return res.json(rows[0]);
    }
    const { rows } = await pool.query(
      `INSERT INTO participant_timings (registration_id, event_id, chest_no, start_time, timed_by)
       VALUES ($1,$2,$3,NOW(),$4) RETURNING *`, [registration_id, req.params.event_id, chest_number || null, req.user.id]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// POST /:event_id/stop — { registration_id }
router.post('/:event_id/stop', async (req, res, next) => {
  try {
    const { registration_id } = req.body;
    const ex = await latestTiming(registration_id, req.params.event_id);
    if (!ex || ex.end_time) return res.status(409).json({ error: 'No running timer for this chest' });
    const { rows } = await pool.query(`UPDATE participant_timings SET end_time = NOW() WHERE id = $1 RETURNING *`, [ex.id]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'TIMER_STOP', entity: 'participant_timings', entityId: ex.id, details: { registration_id, time_taken: rows[0].time_taken_seconds } });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /:event_id/override — { registration_id, seconds, email, password }  (Chairman only)
router.post('/:event_id/override', async (req, res, next) => {
  try {
    const { registration_id, seconds, email, password } = req.body;
    if (!registration_id || seconds == null || !email || !password)
      return res.status(400).json({ error: 'registration_id, seconds, email and Chairman password are required' });
    const { rows: u } = await pool.query(`SELECT id, password_hash, role FROM users WHERE email = $1`, [email.toLowerCase()]);
    if (!u[0] || !['Chairman', 'SuperAdmin'].includes(u[0].role)) return res.status(403).json({ error: 'Chairman/SuperAdmin credentials required' });
    const ok = await bcrypt.compare(password, u[0].password_hash);
    if (!ok) return res.status(403).json({ error: 'Invalid password' });
    const s = Math.max(0, Math.round(Number(seconds)));
    const ex = await latestTiming(registration_id, req.params.event_id);
    let row;
    if (ex && ex.start_time) {
      const { rows } = await pool.query(
        `UPDATE participant_timings SET end_time = start_time + ($1 * INTERVAL '1 second'),
           notes = COALESCE(notes, '') || ' [chairman-corrected]' WHERE id = $2 RETURNING *`, [s, ex.id]);
      row = rows[0];
    } else if (ex) {
      const { rows } = await pool.query(
        `UPDATE participant_timings SET start_time = NOW() - ($1 * INTERVAL '1 second'), end_time = NOW(),
           notes = COALESCE(notes, '') || ' [chairman-corrected]' WHERE id = $2 RETURNING *`, [s, ex.id]);
      row = rows[0];
    } else {
      const { rows } = await pool.query(
        `INSERT INTO participant_timings (registration_id, event_id, start_time, end_time, timed_by, notes)
         VALUES ($1,$2, NOW() - ($3 * INTERVAL '1 second'), NOW(), $4, '[chairman-set]') RETURNING *`,
        [registration_id, req.params.event_id, s, u[0].id]);
      row = rows[0];
    }
    await logAudit({ actorId: u[0].id, actorRole: u[0].role,
      action: 'TIMER_OVERRIDE', entity: 'participant_timings', entityId: row.id, details: { registration_id, seconds: s } });
    res.json(row);
  } catch (err) { next(err); }
});

module.exports = router;

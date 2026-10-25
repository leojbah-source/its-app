// src/routes/admin.grouptimer.routes.js  (mounted at /api/admin/group-timer)
// Whole-group timer for NON-STAGE written events. One countdown per
// (event, age group): the office starts it when the subject is given; it ends
// automatically after the event's allotted time. Independent of chest numbers.
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

const runRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'EventStaff'];
const clearRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman'];

async function activeYearId() {
  const { rows } = await pool.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
  return rows[0]?.id || null;
}

// Shape a timer row (+ now) into a state object the UI can render.
function shapeTimer(t) {
  if (!t || !t.started_at) return null;
  const now = Date.now();
  const ends = new Date(t.ends_at).getTime();
  const endedEarly = !!t.ended_at;
  const finished = endedEarly || now >= ends;
  const remaining_seconds = finished ? 0 : Math.max(0, Math.round((ends - now) / 1000));
  return {
    duration_seconds: t.duration_seconds,
    started_at: t.started_at,
    ends_at: t.ends_at,
    ended_at: t.ended_at,
    state: finished ? 'finished' : 'running',
    remaining_seconds,
    now_iso: new Date(now).toISOString(),
  };
}

async function loadEvent(eventId, ageGroupId) {
  const { rows } = await pool.query(
    `SELECT e.id, e.event_code, e.event_name, e.is_stage_event, e.allotted_time_seconds,
            ag.code AS age_group_code, ag.label AS age_group_label
       FROM events e, age_groups ag
      WHERE e.id = $1 AND ag.id = $2`, [eventId, ageGroupId]);
  return rows[0] || null;
}

async function loadTimer(eventId, ageGroupId) {
  const { rows } = await pool.query(
    `SELECT * FROM event_group_timers WHERE event_id = $1 AND age_group_id = $2`, [eventId, ageGroupId]);
  return rows[0] || null;
}

// GET /api/admin/group-timer?event_id=&age_group_id=
router.get('/', requireRole(...runRoles, 'Media', 'Viewer', 'Accountant', 'Registrar'), async (req, res, next) => {
  try {
    const eventId = Number(req.query.event_id), ageGroupId = Number(req.query.age_group_id);
    if (!eventId || !ageGroupId) return res.status(400).json({ error: 'event_id and age_group_id are required' });
    const ev = await loadEvent(eventId, ageGroupId);
    if (!ev) return res.status(404).json({ error: 'Event or age group not found' });
    const t = await loadTimer(eventId, ageGroupId);
    res.json({ event: ev, timer: shapeTimer(t) });
  } catch (err) { next(err); }
});

// POST /start — start (or restart) the group timer. Duration = event's allotted time.
router.post('/start', requireRole(...runRoles), async (req, res, next) => {
  try {
    const eventId = Number(req.body.event_id), ageGroupId = Number(req.body.age_group_id);
    if (!eventId || !ageGroupId) return res.status(400).json({ error: 'event_id and age_group_id are required' });
    const yearId = await activeYearId();
    if (!yearId) return res.status(400).json({ error: 'No active year' });
    const ev = await loadEvent(eventId, ageGroupId);
    if (!ev) return res.status(404).json({ error: 'Event or age group not found' });
    const duration = Math.max(60, Number(ev.allotted_time_seconds) || 0);

    const { rows } = await pool.query(
      `INSERT INTO event_group_timers
         (year_id, event_id, age_group_id, duration_seconds, started_at, ends_at, ended_at, started_by, updated_at)
       VALUES ($1,$2,$3,$4, NOW(), NOW() + $6::interval, NULL, $5, NOW())
       ON CONFLICT (event_id, age_group_id) DO UPDATE SET
         duration_seconds = EXCLUDED.duration_seconds,
         started_at = NOW(), ends_at = NOW() + $6::interval,
         ended_at = NULL, started_by = $5, updated_at = NOW()
       RETURNING *`,
      [yearId, eventId, ageGroupId, duration, req.user.id, `${duration} seconds`]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'GROUP_TIMER_START', entity: 'event_group_timers', entityId: rows[0].id,
      details: { event_id: eventId, age_group_id: ageGroupId, duration_seconds: duration } });
    res.json({ event: ev, timer: shapeTimer(rows[0]) });
  } catch (err) { next(err); }
});

// POST /stop — end the group early (everyone's done).
router.post('/stop', requireRole(...runRoles), async (req, res, next) => {
  try {
    const eventId = Number(req.body.event_id), ageGroupId = Number(req.body.age_group_id);
    const { rows } = await pool.query(
      `UPDATE event_group_timers SET ended_at = NOW(), updated_at = NOW()
        WHERE event_id = $1 AND age_group_id = $2 AND started_at IS NOT NULL AND ended_at IS NULL
        RETURNING *`, [eventId, ageGroupId]);
    if (!rows[0]) return res.status(400).json({ error: 'No running timer to stop.' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'GROUP_TIMER_STOP', entity: 'event_group_timers', entityId: rows[0].id,
      details: { event_id: eventId, age_group_id: ageGroupId } });
    const ev = await loadEvent(eventId, ageGroupId);
    res.json({ event: ev, timer: shapeTimer(rows[0]) });
  } catch (err) { next(err); }
});

// POST /extend { minutes } — add minutes; reopens an early-stopped timer.
router.post('/extend', requireRole(...runRoles), async (req, res, next) => {
  try {
    const eventId = Number(req.body.event_id), ageGroupId = Number(req.body.age_group_id);
    const minutes = Math.round(Number(req.body.minutes) || 0);
    if (!minutes || minutes < 1 || minutes > 120) return res.status(400).json({ error: 'minutes must be between 1 and 120' });
    const { rows } = await pool.query(
      `UPDATE event_group_timers
          SET ends_at = GREATEST(ends_at, NOW()) + $4::interval,
              ended_at = NULL, duration_seconds = duration_seconds + $3, updated_at = NOW()
        WHERE event_id = $1 AND age_group_id = $2 AND started_at IS NOT NULL
        RETURNING *`, [eventId, ageGroupId, minutes * 60, `${minutes} minutes`]);
    if (!rows[0]) return res.status(400).json({ error: 'No started timer to extend.' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'GROUP_TIMER_EXTEND', entity: 'event_group_timers', entityId: rows[0].id,
      details: { event_id: eventId, age_group_id: ageGroupId, minutes } });
    const ev = await loadEvent(eventId, ageGroupId);
    res.json({ event: ev, timer: shapeTimer(rows[0]) });
  } catch (err) { next(err); }
});

// POST /clear — remove the timer entirely (back to not started). For a mistaken
// start. Organisers only.
router.post('/clear', requireRole(...clearRoles), async (req, res, next) => {
  try {
    const eventId = Number(req.body.event_id), ageGroupId = Number(req.body.age_group_id);
    const { rows } = await pool.query(
      `DELETE FROM event_group_timers WHERE event_id = $1 AND age_group_id = $2 RETURNING id`,
      [eventId, ageGroupId]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'GROUP_TIMER_CLEAR', entity: 'event_group_timers', entityId: rows[0]?.id || null,
      details: { event_id: eventId, age_group_id: ageGroupId } });
    const ev = await loadEvent(eventId, ageGroupId);
    res.json({ event: ev, timer: null });
  } catch (err) { next(err); }
});

module.exports = router;

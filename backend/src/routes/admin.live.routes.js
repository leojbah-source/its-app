// src/routes/admin.live.routes.js  (mounted at /api/admin/live)
// Day-wide LIVE PROGRESS, read-only. For each scheduled (event, age group) on a
// date it shows each chest/participant's status taken from the Timer:
//   pending → on stage now → done.
// Lets organisers see where every group has reached without logging in as the
// MC or Timer. Live status is only meaningful for events that are actually timed
// (stage events); others are shown but not tracked live.
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const viewRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Registrar', 'Accountant', 'EventStaff', 'Media', 'Viewer'];

// GET /api/admin/live/dates — scheduled dates for the picker.
router.get('/dates', requireRole(...viewRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT to_char(s.event_date,'YYYY-MM-DD') AS d
         FROM schedule s JOIN year_config y ON y.id = s.year_id AND y.is_active = TRUE
        WHERE s.event_date IS NOT NULL ORDER BY d`);
    res.json(rows.map((r) => r.d));
  } catch (err) { next(err); }
});

// GET /api/admin/live/day?date=YYYY-MM-DD
router.get('/day', requireRole(...viewRoles), async (req, res, next) => {
  try {
    const date = req.query.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    const { rows: yc } = await pool.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
    if (!yc[0]) return res.json([]);

    const { rows } = await pool.query(
      `SELECT s.id AS sched_id, s.venue, to_char(s.start_time,'HH24:MI') AS start_time, s.status,
              s.event_id, e.event_code, e.event_name, e.is_stage_event,
              ag.id AS ag_id, ag.code AS ag_code, ag.label AS ag_label, ag.sort_order AS ag_sort,
              r.id AS registration_id, COALESCE(p.full_name, t.team_name) AS name,
              ca.chest_number,
              pt.start_time AS t_start, pt.end_time AS t_end, pt.flag_for_dq,
              egt.started_at AS gt_started, egt.ends_at AS gt_ends, egt.ended_at AS gt_ended,
              egt.duration_seconds AS gt_duration
         FROM schedule s
         JOIN events e ON e.id = s.event_id
         JOIN age_groups ag ON ag.year_id = s.year_id AND ag.code = ANY(string_to_array(s.age_groups, ', '))
         LEFT JOIN registrations r ON r.event_id = s.event_id AND r.age_group_id = ag.id AND r.status = 'attended'
         LEFT JOIN chest_assignments ca ON ca.registration_id = r.id
         LEFT JOIN participants p ON p.id = r.participant_id
         LEFT JOIN teams t ON t.id = r.team_id
         LEFT JOIN event_group_timers egt ON egt.event_id = s.event_id AND egt.age_group_id = ag.id
         LEFT JOIN LATERAL (SELECT start_time, end_time, flag_for_dq FROM participant_timings pt2
                             WHERE pt2.registration_id = r.id AND pt2.event_id = s.event_id
                             ORDER BY pt2.id DESC LIMIT 1) pt ON TRUE
        WHERE s.year_id = $1 AND s.event_date = $2
        ORDER BY s.start_time NULLS LAST, s.venue, e.event_code, ag.sort_order NULLS LAST, ca.chest_number NULLS LAST, name`,
      [yc[0].id, date]);

    const groups = new Map();
    for (const r of rows) {
      const key = `${r.sched_id}:${r.ag_code}`;
      if (!groups.has(key)) groups.set(key, {
        key, event_id: r.event_id, event_code: r.event_code, event_name: r.event_name,
        is_stage_event: r.is_stage_event, venue: r.venue, start_time: r.start_time, status: r.status,
        age_group_code: r.ag_code, age_group_label: r.ag_label, participants: [],
        _gt: (r.gt_started ? { started_at: r.gt_started, ends_at: r.gt_ends, ended_at: r.gt_ended, duration_seconds: r.gt_duration } : null) });
      if (r.registration_id) {
        const status = r.t_start && r.t_end ? 'done' : r.t_start ? 'running' : 'pending';
        groups.get(key).participants.push({
          registration_id: r.registration_id, chest_number: r.chest_number,
          name: r.name || '', status, over: !!r.flag_for_dq });
      }
    }

    const nowMs = Date.now();
    const shapeGT = (gt) => {
      if (!gt || !gt.started_at) return null;
      const ends = new Date(gt.ends_at).getTime();
      const finished = !!gt.ended_at || nowMs >= ends;
      return {
        started_at: gt.started_at, ends_at: gt.ends_at, ended_at: gt.ended_at,
        duration_seconds: gt.duration_seconds,
        state: finished ? 'finished' : 'running',
        remaining_seconds: finished ? 0 : Math.max(0, Math.round((ends - nowMs) / 1000)),
      };
    };
    const out = [...groups.values()].map((g) => {
      const { _gt, ...rest } = g;
      const group_timer = shapeGT(_gt);
      const total = g.participants.length;
      const done = g.participants.filter((p) => p.status === 'done').length;
      const running = g.participants.filter((p) => p.status === 'running');
      // A whole-group timer (written events) drives the state; otherwise fall
      // back to the per-performer (stage) timing.
      const state = group_timer
        ? group_timer.state
        : total === 0 ? 'empty'
          : done === total ? 'finished'
          : running.length ? 'running'
          : done > 0 ? 'in_progress' : 'not_started';
      return {
        ...rest, group_timer, total, done, running_count: running.length,
        now: running.map((p) => ({ chest_number: p.chest_number, name: p.name })),
        state,
      };
    });
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;

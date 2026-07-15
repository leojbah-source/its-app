// src/routes/admin.chest.routes.js  (mounted at /api/admin/chest)
// Day-of operations: mark ATTENDANCE, then assign CHEST NUMBERS (rule #3 —
// after attendance, never in advance; continuous numbering; rule #4 — manual
// entry is Chairman/SuperAdmin only).
//
// Real schema (verified):
//   registrations(status registration_status enum 'registered'|'attended'|
//     'absent'|'withdrawn'|'swapped', attendance_marked_by, attendance_marked_at)
//   chest_assignments(id, year_id, event_id, time_slot_id, registration_id UNIQUE,
//     chest_number, allocation_mode CHECK('auto','timeslot','manual'),
//     allocated_by, allocated_at, UNIQUE(event_id, chest_number))
//   event_time_slots(id, event_id, slot_label, sort_order, ...)
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);
const staffRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'];
const markRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman'];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function eventYearId(eventId) {
  const { rows } = await pool.query(`SELECT year_id FROM events WHERE id = $1`, [eventId]);
  return rows[0]?.year_id || null;
}

// ── GET /api/admin/chest/:event_id/roster — attendance + chest per entry ──────
router.get('/:event_id/roster', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id AS registration_id, r.status, r.time_slot_id,
              COALESCE(p.full_name, t.team_name) AS name,
              ag.code AS age_group,
              ca.chest_number
       FROM registrations r
       LEFT JOIN participants p ON p.id = r.participant_id
       LEFT JOIN teams t ON t.id = r.team_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       LEFT JOIN chest_assignments ca ON ca.registration_id = r.id
       WHERE r.event_id = $1 AND r.status NOT IN ('withdrawn','swapped')
       ORDER BY ca.chest_number NULLS LAST, name`, [req.params.event_id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/chest/:event_id — chest assignments (with name) ───────────
router.get('/:event_id', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ca.registration_id, ca.chest_number, ca.allocation_mode, ca.allocated_at,
              COALESCE(p.full_name, t.team_name) AS name
       FROM chest_assignments ca
       JOIN registrations r ON r.id = ca.registration_id
       LEFT JOIN participants p ON p.id = r.participant_id
       LEFT JOIN teams t ON t.id = r.team_id
       WHERE ca.event_id = $1 ORDER BY ca.chest_number`, [req.params.event_id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/admin/chest/:event_id/attendance — mark present/absent ─────────
// body: { registration_id, present: bool }
router.post('/:event_id/attendance', requireRole(...markRoles), async (req, res, next) => {
  try {
    const { registration_id, present } = req.body;
    if (!registration_id) return res.status(400).json({ error: 'registration_id is required' });
    const status = present ? 'attended' : 'absent';
    const { rows } = await pool.query(
      `UPDATE registrations
         SET status = $1, attendance_marked_by = $2, attendance_marked_at = NOW(), updated_at = NOW()
       WHERE id = $3 AND event_id = $4 AND status NOT IN ('withdrawn','swapped')
       RETURNING id AS registration_id, status`,
      [status, req.user.id, registration_id, req.params.event_id]);
    if (!rows[0]) return res.status(404).json({ error: 'Registration not found for this event' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'MARK_ATTENDANCE', entity: 'registrations', entityId: registration_id, details: { status } });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/admin/chest/:event_id/assign-auto — random chests, attendees ───
router.post('/:event_id/assign-auto', requireRole(...markRoles), async (req, res, next) => {
  try {
    const yearId = await eventYearId(req.params.event_id);
    if (!yearId) return res.status(404).json({ error: 'Event not found' });
    const { rows: pending } = await pool.query(
      `SELECT r.id AS registration_id, r.time_slot_id FROM registrations r
       WHERE r.event_id = $1 AND r.status = 'attended'
         AND r.id NOT IN (SELECT registration_id FROM chest_assignments WHERE event_id = $1)`,
      [req.params.event_id]);
    if (!pending.length) return res.status(400).json({ error: 'No attended entries awaiting chest numbers. Mark attendance first.' });

    const { rows: mx } = await pool.query(
      `SELECT COALESCE(MAX(chest_number), 0) AS max_no FROM chest_assignments WHERE event_id = $1`,
      [req.params.event_id]);
    let next_no = Number(mx[0].max_no) + 1;

    const assigned = [];
    for (const reg of shuffle(pending)) {
      const { rows } = await pool.query(
        `INSERT INTO chest_assignments
           (year_id, event_id, time_slot_id, registration_id, chest_number, allocation_mode, allocated_by)
         VALUES ($1,$2,$3,$4,$5,'auto',$6) RETURNING registration_id, chest_number`,
        [yearId, req.params.event_id, reg.time_slot_id, reg.registration_id, next_no, req.user.id]);
      assigned.push(rows[0]); next_no++;
    }
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'ASSIGN_CHEST_AUTO', entity: 'chest_assignments', entityId: req.params.event_id, details: { count: assigned.length } });
    res.status(201).json(assigned);
  } catch (err) { next(err); }
});

// ── POST /api/admin/chest/:event_id/assign-timeslot — lot draw per slot ──────
router.post('/:event_id/assign-timeslot', requireRole(...markRoles), async (req, res, next) => {
  try {
    const yearId = await eventYearId(req.params.event_id);
    if (!yearId) return res.status(404).json({ error: 'Event not found' });
    const { rows: slots } = await pool.query(
      `SELECT id FROM event_time_slots WHERE event_id = $1 ORDER BY sort_order, id`,
      [req.params.event_id]);
    if (!slots.length) return res.status(400).json({ error: 'No time slots configured for this event' });

    const { rows: mx } = await pool.query(
      `SELECT COALESCE(MAX(chest_number), 0) AS max_no FROM chest_assignments WHERE event_id = $1`,
      [req.params.event_id]);
    let next_no = Number(mx[0].max_no) + 1;
    const assigned = [];

    for (const slot of slots) {
      const { rows: pending } = await pool.query(
        `SELECT r.id AS registration_id FROM registrations r
         WHERE r.event_id = $1 AND r.status = 'attended' AND r.time_slot_id = $2
           AND r.id NOT IN (SELECT registration_id FROM chest_assignments WHERE event_id = $1)`,
        [req.params.event_id, slot.id]);
      for (const reg of shuffle(pending)) {
        const { rows } = await pool.query(
          `INSERT INTO chest_assignments
             (year_id, event_id, time_slot_id, registration_id, chest_number, allocation_mode, allocated_by)
           VALUES ($1,$2,$3,$4,$5,'timeslot',$6) RETURNING registration_id, chest_number`,
          [yearId, req.params.event_id, slot.id, reg.registration_id, next_no, req.user.id]);
        assigned.push(rows[0]); next_no++;
      }
    }
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'ASSIGN_CHEST_TIMESLOT', entity: 'chest_assignments', entityId: req.params.event_id, details: { count: assigned.length } });
    res.status(201).json(assigned);
  } catch (err) { next(err); }
});

// ── PUT /api/admin/chest/manual/:reg_id — Chairman/SuperAdmin only (rule #4) ──
router.put('/manual/:reg_id', requireRole('Chairman', 'SuperAdmin'), async (req, res, next) => {
  try {
    const { event_id, chest_number } = req.body;
    if (!event_id || !chest_number) return res.status(400).json({ error: 'event_id and chest_number are required' });
    const yearId = await eventYearId(event_id);
    if (!yearId) return res.status(404).json({ error: 'Event not found' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO chest_assignments
           (year_id, event_id, registration_id, chest_number, allocation_mode, allocated_by)
         VALUES ($1,$2,$3,$4,'manual',$5)
         ON CONFLICT (registration_id) DO UPDATE
           SET chest_number = EXCLUDED.chest_number, allocation_mode = 'manual',
               allocated_by = EXCLUDED.allocated_by, allocated_at = NOW()
         RETURNING registration_id, chest_number`,
        [yearId, event_id, req.params.reg_id, chest_number, req.user.id]);
      await logAudit({ actorId: req.user.id, actorRole: req.user.role,
        action: 'MANUAL_CHEST_NUMBER', entity: 'chest_assignments', entityId: req.params.reg_id, details: { event_id, chest_number } });
      res.json(rows[0]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: `Chest number ${chest_number} is already used in this event` });
      throw e;
    }
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/chest/:event_id — clear all chests (Chairman/SuperAdmin) ─
router.delete('/:event_id', requireRole('Chairman', 'SuperAdmin'), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM chest_assignments WHERE event_id = $1`, [req.params.event_id]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'CLEAR_CHESTS', entity: 'chest_assignments', entityId: req.params.event_id, details: { removed: rowCount } });
    res.json({ removed: rowCount });
  } catch (err) { next(err); }
});

module.exports = router;

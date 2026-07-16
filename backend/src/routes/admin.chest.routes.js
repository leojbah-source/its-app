// src/routes/admin.chest.routes.js  (mounted at /api/admin/chest)
// Day-of operations, PER AGE GROUP: mark ATTENDANCE, then assign CHEST NUMBERS.
// Chest numbers restart at 1 for each (event, age group) — groups run one after
// another and numbers don't carry forward (migration 017). Rule #3: after
// attendance, never in advance. Rule #4: manual entry is Chairman/SuperAdmin.
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
// Chest numbers lock once judging has started — i.e. any score exists for a
// registration in this (event, age group). Prevents reshuffling mid-contest.
async function groupLocked(eventId, ageGroupId) {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM scores s JOIN registrations r ON r.id = s.registration_id
       WHERE r.event_id = $1 AND ($2::int IS NULL OR r.age_group_id = $2)
     ) AS locked`, [eventId, ageGroupId]);
  return rows[0].locked;
}
// Count entries in the group still awaiting an attendance decision.
async function groupUnmarked(eventId, ageGroupId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM registrations
     WHERE event_id = $1 AND age_group_id = $2 AND status = 'registered'`, [eventId, ageGroupId]);
  return rows[0].c;
}
const grp = (v) => (v === '' || v === undefined || v === null ? null : Number(v));

// ── GET /api/admin/chest/:event_id/groups — age groups for the event ─────────
router.get('/:event_id/groups', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ag.id AS age_group_id, ag.code, ag.label, ag.sort_order,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE r.status = 'attended')::int AS attended,
              COUNT(ca.registration_id)::int AS with_chest,
              EXISTS (SELECT 1 FROM scores s JOIN registrations r2 ON r2.id = s.registration_id
                      WHERE r2.event_id = $1 AND r2.age_group_id = ag.id) AS locked
       FROM registrations r
       JOIN age_groups ag ON ag.id = r.age_group_id
       LEFT JOIN chest_assignments ca ON ca.registration_id = r.id
       WHERE r.event_id = $1 AND r.status NOT IN ('withdrawn','swapped')
       GROUP BY ag.id, ag.code, ag.label, ag.sort_order
       ORDER BY ag.sort_order, ag.code`, [req.params.event_id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/chest/:event_id/roster?age_group_id= — roster (per group) ──
router.get('/:event_id/roster', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const ag = grp(req.query.age_group_id);
    const { rows } = await pool.query(
      `SELECT r.id AS registration_id, r.status, r.time_slot_id, r.age_group_id,
              COALESCE(p.full_name, t.team_name) AS name,
              ag.code AS age_group,
              ca.chest_number
       FROM registrations r
       LEFT JOIN participants p ON p.id = r.participant_id
       LEFT JOIN teams t ON t.id = r.team_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       LEFT JOIN chest_assignments ca ON ca.registration_id = r.id
       WHERE r.event_id = $1 AND r.status NOT IN ('withdrawn','swapped')
         AND ($2::int IS NULL OR r.age_group_id = $2)
       ORDER BY ca.chest_number NULLS LAST, name`, [req.params.event_id, ag]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/admin/chest/:event_id/attendance — mark present/absent ─────────
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

// ── POST /api/admin/chest/:event_id/assign-auto — random chests, ONE group ───
// body: { age_group_id }  (numbering restarts at 1 within the group)
router.post('/:event_id/assign-auto', requireRole(...markRoles), async (req, res, next) => {
  try {
    const ag = grp(req.body.age_group_id);
    if (!ag) return res.status(400).json({ error: 'age_group_id is required' });
    const yearId = await eventYearId(req.params.event_id);
    if (!yearId) return res.status(404).json({ error: 'Event not found' });
    if (await groupLocked(req.params.event_id, ag))
      return res.status(409).json({ error: 'Chest numbers are locked — judging has started for this group.' });
    if (await groupUnmarked(req.params.event_id, ag) > 0)
      return res.status(409).json({ error: 'Mark every participant present or absent before assigning chest numbers.' });

    const { rows: pending } = await pool.query(
      `SELECT r.id AS registration_id, r.time_slot_id FROM registrations r
       WHERE r.event_id = $1 AND r.age_group_id = $2 AND r.status = 'attended'
         AND r.id NOT IN (SELECT registration_id FROM chest_assignments WHERE event_id = $1 AND age_group_id = $2)`,
      [req.params.event_id, ag]);
    if (!pending.length) return res.status(400).json({ error: 'No attended entries in this group awaiting chest numbers.' });

    const { rows: mx } = await pool.query(
      `SELECT COALESCE(MAX(chest_number), 0) AS max_no FROM chest_assignments WHERE event_id = $1 AND age_group_id = $2`,
      [req.params.event_id, ag]);
    let next_no = Number(mx[0].max_no) + 1;

    const assigned = [];
    for (const reg of shuffle(pending)) {
      const { rows } = await pool.query(
        `INSERT INTO chest_assignments
           (year_id, event_id, age_group_id, time_slot_id, registration_id, chest_number, allocation_mode, allocated_by)
         VALUES ($1,$2,$3,$4,$5,$6,'auto',$7) RETURNING registration_id, chest_number`,
        [yearId, req.params.event_id, ag, reg.time_slot_id, reg.registration_id, next_no, req.user.id]);
      assigned.push(rows[0]); next_no++;
    }
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'ASSIGN_CHEST_AUTO', entity: 'chest_assignments', entityId: req.params.event_id, details: { age_group_id: ag, count: assigned.length } });
    res.status(201).json(assigned);
  } catch (err) { next(err); }
});

// ── POST /api/admin/chest/:event_id/assign-timeslot — lot draw per slot, one group ─
router.post('/:event_id/assign-timeslot', requireRole(...markRoles), async (req, res, next) => {
  try {
    const ag = grp(req.body.age_group_id);
    if (!ag) return res.status(400).json({ error: 'age_group_id is required' });
    const yearId = await eventYearId(req.params.event_id);
    if (!yearId) return res.status(404).json({ error: 'Event not found' });
    if (await groupLocked(req.params.event_id, ag))
      return res.status(409).json({ error: 'Chest numbers are locked — judging has started for this group.' });
    if (await groupUnmarked(req.params.event_id, ag) > 0)
      return res.status(409).json({ error: 'Mark every participant present or absent before assigning chest numbers.' });
    const { rows: slots } = await pool.query(
      `SELECT id FROM event_time_slots WHERE event_id = $1 ORDER BY sort_order, id`, [req.params.event_id]);
    if (!slots.length) return res.status(400).json({ error: 'No time slots configured for this event' });

    const { rows: mx } = await pool.query(
      `SELECT COALESCE(MAX(chest_number), 0) AS max_no FROM chest_assignments WHERE event_id = $1 AND age_group_id = $2`,
      [req.params.event_id, ag]);
    let next_no = Number(mx[0].max_no) + 1;
    const assigned = [];
    for (const slot of slots) {
      const { rows: pending } = await pool.query(
        `SELECT r.id AS registration_id FROM registrations r
         WHERE r.event_id = $1 AND r.age_group_id = $2 AND r.status = 'attended' AND r.time_slot_id = $3
           AND r.id NOT IN (SELECT registration_id FROM chest_assignments WHERE event_id = $1 AND age_group_id = $2)`,
        [req.params.event_id, ag, slot.id]);
      for (const reg of shuffle(pending)) {
        const { rows } = await pool.query(
          `INSERT INTO chest_assignments
             (year_id, event_id, age_group_id, time_slot_id, registration_id, chest_number, allocation_mode, allocated_by)
           VALUES ($1,$2,$3,$4,$5,$6,'timeslot',$7) RETURNING registration_id, chest_number`,
          [yearId, req.params.event_id, ag, slot.id, reg.registration_id, next_no, req.user.id]);
        assigned.push(rows[0]); next_no++;
      }
    }
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'ASSIGN_CHEST_TIMESLOT', entity: 'chest_assignments', entityId: req.params.event_id, details: { age_group_id: ag, count: assigned.length } });
    res.status(201).json(assigned);
  } catch (err) { next(err); }
});

// ── PUT /api/admin/chest/manual/:reg_id — Chairman/SuperAdmin only (rule #4) ──
router.put('/manual/:reg_id', requireRole('Chairman', 'SuperAdmin'), async (req, res, next) => {
  try {
    const { event_id, chest_number } = req.body;
    if (!event_id || !chest_number) return res.status(400).json({ error: 'event_id and chest_number are required' });
    const { rows: reg } = await pool.query(
      `SELECT year_id, age_group_id FROM registrations WHERE id = $1 AND event_id = $2`, [req.params.reg_id, event_id]);
    if (!reg[0]) return res.status(404).json({ error: 'Registration not found for this event' });
    if (await groupLocked(event_id, reg[0].age_group_id))
      return res.status(409).json({ error: 'Chest numbers are locked — judging has started for this group.' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO chest_assignments
           (year_id, event_id, age_group_id, registration_id, chest_number, allocation_mode, allocated_by)
         VALUES ($1,$2,$3,$4,$5,'manual',$6)
         ON CONFLICT (registration_id) DO UPDATE
           SET chest_number = EXCLUDED.chest_number, allocation_mode = 'manual',
               age_group_id = EXCLUDED.age_group_id, allocated_by = EXCLUDED.allocated_by, allocated_at = NOW()
         RETURNING registration_id, chest_number`,
        [reg[0].year_id, event_id, reg[0].age_group_id, req.params.reg_id, chest_number, req.user.id]);
      await logAudit({ actorId: req.user.id, actorRole: req.user.role,
        action: 'MANUAL_CHEST_NUMBER', entity: 'chest_assignments', entityId: req.params.reg_id, details: { event_id, chest_number } });
      res.json(rows[0]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: `Chest number ${chest_number} is already used in this group` });
      throw e;
    }
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/chest/:event_id?age_group_id= — clear (group or all) ────
router.delete('/:event_id', requireRole('Chairman', 'SuperAdmin'), async (req, res, next) => {
  try {
    const ag = grp(req.query.age_group_id);
    const reason = (req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to clear chest numbers.' });
    if (await groupLocked(req.params.event_id, ag))
      return res.status(409).json({ error: 'Chest numbers are locked — judging has started.' });
    const { rowCount } = await pool.query(
      `DELETE FROM chest_assignments WHERE event_id = $1 AND ($2::int IS NULL OR age_group_id = $2)`,
      [req.params.event_id, ag]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'CLEAR_CHESTS', entity: 'chest_assignments', entityId: req.params.event_id, details: { age_group_id: ag, removed: rowCount, reason } });
    res.json({ removed: rowCount });
  } catch (err) { next(err); }
});

module.exports = router;

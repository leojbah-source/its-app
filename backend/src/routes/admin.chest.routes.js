// src/routes/admin.chest.routes.js  (mounted at /api/admin/chest)
// Rule #3: chest numbers assigned randomly on the day AFTER attendance marked,
// never in advance. Time-slot mode = lot draw per slot, continuous numbers
// across all slots. Rule #4: manual entry is Chairman/SuperAdmin only.
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);
const staffRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'];
const markRoles = ['SuperAdmin', 'Admin', 'Coordinator'];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// POST /api/admin/chest/:event_id/attendance/:reg_id
router.post('/:event_id/attendance/:reg_id', requireRole(...markRoles), async (req, res, next) => {
  try {
    const { present } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO attendance (event_id, registration_id, present, marked_by, marked_at)
       VALUES ($1,$2,$3,$4, NOW())
       ON CONFLICT (event_id, registration_id) DO UPDATE
         SET present = EXCLUDED.present, marked_by = EXCLUDED.marked_by, marked_at = NOW()
       RETURNING *`,
      [req.params.event_id, req.params.reg_id, Boolean(present), req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/chest/:event_id/assign-random  -- auto batch assignment, attendees only
router.post('/:event_id/assign-random', requireRole(...markRoles), async (req, res, next) => {
  try {
    const { rows: present } = await pool.query(
      `SELECT a.registration_id FROM attendance a
       WHERE a.event_id = $1 AND a.present = true
         AND a.registration_id NOT IN (SELECT registration_id FROM chest_numbers WHERE event_id = $1)`,
      [req.params.event_id]
    );
    if (present.length === 0) return res.status(400).json({ error: 'No marked-present registrations awaiting chest numbers' });

    const { rows: existingMax } = await pool.query(
      `SELECT COALESCE(MAX(chest_number), 0) AS max_no FROM chest_numbers WHERE event_id = $1`,
      [req.params.event_id]
    );
    let next_no = Number(existingMax[0].max_no) + 1;

    const shuffled = shuffle(present);
    const assigned = [];
    for (const reg of shuffled) {
      const { rows } = await pool.query(
        `INSERT INTO chest_numbers (event_id, registration_id, chest_number, mode, assigned_by, assigned_at)
         VALUES ($1,$2,$3,'random',$4, NOW()) RETURNING *`,
        [req.params.event_id, reg.registration_id, next_no, req.user.id]
      );
      assigned.push(rows[0]);
      next_no++;
    }
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'ASSIGN_CHEST_RANDOM', entity: 'chest_numbers', entityId: req.params.event_id, details: { count: assigned.length } });
    res.status(201).json(assigned);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/chest/:event_id/assign-timeslot  -- lot draw per slot, continuous numbers across slots
router.post('/:event_id/assign-timeslot', requireRole(...markRoles), async (req, res, next) => {
  try {
    const { rows: slots } = await pool.query(
      `SELECT id FROM time_slots WHERE event_id = $1 ORDER BY start_time`,
      [req.params.event_id]
    );
    if (slots.length === 0) return res.status(400).json({ error: 'No time slots configured for this event' });

    const { rows: existingMax } = await pool.query(
      `SELECT COALESCE(MAX(chest_number), 0) AS max_no FROM chest_numbers WHERE event_id = $1`,
      [req.params.event_id]
    );
    let next_no = Number(existingMax[0].max_no) + 1;
    const assigned = [];

    for (const slot of slots) {
      const { rows: present } = await pool.query(
        `SELECT a.registration_id FROM attendance a
         JOIN registrations r ON r.id = a.registration_id
         WHERE a.event_id = $1 AND a.present = true AND r.time_slot_id = $2
           AND a.registration_id NOT IN (SELECT registration_id FROM chest_numbers WHERE event_id = $1)`,
        [req.params.event_id, slot.id]
      );
      const shuffled = shuffle(present); // lot draw within this slot
      for (const reg of shuffled) {
        const { rows } = await pool.query(
          `INSERT INTO chest_numbers (event_id, registration_id, chest_number, mode, assigned_by, assigned_at)
           VALUES ($1,$2,$3,'timeslot',$4, NOW()) RETURNING *`,
          [req.params.event_id, reg.registration_id, next_no, req.user.id]
        );
        assigned.push(rows[0]);
        next_no++; // continuous across all slots, per Master Context rule #3
      }
    }
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'ASSIGN_CHEST_TIMESLOT', entity: 'chest_numbers', entityId: req.params.event_id, details: { count: assigned.length } });
    res.status(201).json(assigned);
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/chest/manual/:reg_id  -- CHAIRMAN/SUPERADMIN only (rule #4)
router.put('/manual/:reg_id', requireRole('Chairman', 'SuperAdmin'), async (req, res, next) => {
  try {
    const { event_id, chest_number } = req.body;
    if (!event_id || !chest_number) return res.status(400).json({ error: 'event_id and chest_number are required' });

    const { rows } = await pool.query(
      `INSERT INTO chest_numbers (event_id, registration_id, chest_number, mode, assigned_by, assigned_at)
       VALUES ($1,$2,$3,'manual',$4, NOW())
       ON CONFLICT (event_id, registration_id) DO UPDATE
         SET chest_number = EXCLUDED.chest_number, mode = 'manual', assigned_by = EXCLUDED.assigned_by, assigned_at = NOW()
       RETURNING *`,
      [event_id, req.params.reg_id, chest_number, req.user.id]
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'MANUAL_CHEST_NUMBER', entity: 'chest_numbers', entityId: req.params.reg_id, details: { event_id, chest_number } });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/chest/:event_id
router.get('/:event_id', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT cn.*, c.name AS child_name FROM chest_numbers cn
       JOIN registrations r ON r.id = cn.registration_id
       JOIN children c ON c.id = r.child_id
       WHERE cn.event_id = $1 ORDER BY cn.chest_number`,
      [req.params.event_id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

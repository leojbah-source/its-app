// src/routes/admin.events.routes.js  (mounted at /api/admin)
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { sendWhatsApp } = require('../utils/notify');

const router = express.Router();
router.use(authenticate);

const staffRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'];
const editRoles = ['SuperAdmin', 'Admin', 'Coordinator'];

// ---- CRUD /api/admin/events ----
router.get('/events', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { year_id } = req.query;
    const { rows } = await pool.query(
      `SELECT * FROM events WHERE ($1::int IS NULL OR year_id = $1) ORDER BY id`,
      [year_id || null]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/events/:id', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM events WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Event not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.post('/events', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { year_id, name, category, age_group, type, max_participants, is_team_event } = req.body;
    if (!year_id || !name || !category || !age_group) {
      return res.status(400).json({ error: 'year_id, name, category and age_group are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO events (year_id, name, category, age_group, type, max_participants, is_team_event, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active', NOW()) RETURNING *`,
      [year_id, name, category, age_group, type || 'individual', max_participants || null, Boolean(is_team_event)]
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CREATE_EVENT', entity: 'events', entityId: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/events/:id', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { name, category, age_group, type, max_participants, is_team_event, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE events SET
         name = COALESCE($1, name), category = COALESCE($2, category),
         age_group = COALESCE($3, age_group), type = COALESCE($4, type),
         max_participants = COALESCE($5, max_participants),
         is_team_event = COALESCE($6, is_team_event), status = COALESCE($7, status)
       WHERE id = $8 RETURNING *`,
      [name, category, age_group, type, max_participants, is_team_event, status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Event not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'UPDATE_EVENT', entity: 'events', entityId: req.params.id, details: req.body });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/events/:id', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM events WHERE id = $1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Event not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'DELETE_EVENT', entity: 'events', entityId: req.params.id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/events/:id/cancel  -- cancel event; notify affected participants
router.post('/events/:id/cancel', requireRole('SuperAdmin', 'Admin', 'Chairman'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: evRows } = await client.query(
      `UPDATE events SET status = 'cancelled' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!evRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }

    const { rows: affected } = await client.query(
      `SELECT r.id AS registration_id, c.name AS child_name, u.email, c.parent_user_id
       FROM registrations r
       JOIN children c ON c.id = r.child_id
       LEFT JOIN users u ON u.id = c.parent_user_id
       WHERE r.event_id = $1 AND r.status != 'cancelled'`,
      [req.params.id]
    );

    await client.query(
      `UPDATE registrations SET status = 'cancelled_event' WHERE event_id = $1`,
      [req.params.id]
    );
    await client.query('COMMIT');

    for (const reg of affected) {
      // Best-effort notification; failures are logged but don't fail the cancellation
      await sendWhatsApp(reg.phone, `${evRows[0].name} has been cancelled. You may use the swap window to pick a replacement event.`).catch(() => null);
    }

    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CANCEL_EVENT', entity: 'events', entityId: req.params.id, details: { affectedCount: affected.length } });
    res.json({ event: evRows[0], affectedRegistrations: affected.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/admin/events/:id/split-analysis
// Returns whether enrolment exceeds the configured per-event/time-slot capacity,
// so the Admin can decide whether to split into multiple time slots.
router.get('/events/:id/split-analysis', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS total FROM registrations WHERE event_id = $1 AND status != 'cancelled'`,
      [req.params.id]
    );
    const { rows: capRows } = await pool.query(`SELECT max_participants FROM events WHERE id = $1`, [req.params.id]);
    if (!capRows[0]) return res.status(404).json({ error: 'Event not found' });

    const total = Number(countRows[0].total);
    const cap = capRows[0].max_participants;
    const needsSplit = cap != null && total > cap;
    const suggestedSlots = needsSplit ? Math.ceil(total / cap) : 1;

    res.json({ eventId: req.params.id, totalRegistrations: total, capacityPerSlot: cap, needsSplit, suggestedSlots });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/events/:id/confirm-split
router.post('/events/:id/confirm-split', requireRole('SuperAdmin', 'Admin', 'Coordinator'), async (req, res, next) => {
  try {
    const { slot_count, capacity_per_slot } = req.body;
    if (!slot_count || !capacity_per_slot) {
      return res.status(400).json({ error: 'slot_count and capacity_per_slot are required' });
    }
    const created = [];
    for (let i = 1; i <= slot_count; i++) {
      const { rows } = await pool.query(
        `INSERT INTO time_slots (event_id, slot_label, capacity) VALUES ($1, $2, $3) RETURNING *`,
        [req.params.id, `Slot ${i}`, capacity_per_slot]
      );
      created.push(rows[0]);
    }
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CONFIRM_SPLIT', entity: 'events', entityId: req.params.id, details: { slot_count, capacity_per_slot } });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// ---- CRUD /api/admin/events/:id/time-slots ----
router.get('/events/:id/time-slots', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM time_slots WHERE event_id = $1 ORDER BY start_time`, [req.params.id]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/events/:id/time-slots', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { slot_label, start_time, end_time, capacity } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO time_slots (event_id, slot_label, start_time, end_time, capacity)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, slot_label, start_time || null, end_time || null, capacity || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/events/:id/time-slots/:slot_id', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { slot_label, start_time, end_time, capacity } = req.body;
    const { rows } = await pool.query(
      `UPDATE time_slots SET
         slot_label = COALESCE($1, slot_label), start_time = COALESCE($2, start_time),
         end_time = COALESCE($3, end_time), capacity = COALESCE($4, capacity)
       WHERE id = $5 AND event_id = $6 RETURNING *`,
      [slot_label, start_time, end_time, capacity, req.params.slot_id, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Time slot not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/events/:id/time-slots/:slot_id', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM time_slots WHERE id = $1 AND event_id = $2`,
      [req.params.slot_id, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Time slot not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;

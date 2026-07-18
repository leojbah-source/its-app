// src/routes/admin.eventstaff.routes.js  (mounted at /api/admin/event-staff)
// Create MC/Timer staff accounts and assign them per event. Chairman/SuperAdmin.
const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);
const manageRoles = ['SuperAdmin', 'Chairman'];
const EVENT_ROLES = ['MC', 'Timer'];
const tableFor = (role) => (role === 'MC' ? 'mc_assignments' : 'timer_assignments');

// GET /users?role=MC — list MC/Timer accounts
router.get('/users', requireRole(...manageRoles), async (req, res, next) => {
  try {
    const role = req.query.role;
    if (!EVENT_ROLES.includes(role)) return res.status(400).json({ error: 'role must be MC or Timer' });
    const { rows } = await pool.query(
      `SELECT id, full_name, email, phone, is_active FROM users WHERE role = $1 ORDER BY full_name`, [role]);
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /users — create an MC/Timer account
router.post('/users', requireRole(...manageRoles), async (req, res, next) => {
  try {
    const { full_name, email, phone, password, role } = req.body;
    if (!full_name?.trim() || !password || !EVENT_ROLES.includes(role))
      return res.status(400).json({ error: 'full_name, password and role (MC|Timer) are required' });
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, full_name, email, role`,
      [full_name.trim(), email?.toLowerCase() || null, phone || null, hash, role]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'CREATE_EVENT_STAFF', entity: 'users', entityId: rows[0].id, details: { role } });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with that email already exists' });
    next(err);
  }
});

// GET /event/:eventId — who is MC/Timer for this event
router.get('/event/:eventId', requireRole(...manageRoles), async (req, res, next) => {
  try {
    const { rows: mc } = await pool.query(
      `SELECT ma.id AS assignment_id, u.id AS user_id, u.full_name, u.email
       FROM mc_assignments ma JOIN users u ON u.id = ma.user_id WHERE ma.event_id = $1 ORDER BY u.full_name`, [req.params.eventId]);
    const { rows: timer } = await pool.query(
      `SELECT ta.id AS assignment_id, u.id AS user_id, u.full_name, u.email
       FROM timer_assignments ta JOIN users u ON u.id = ta.user_id WHERE ta.event_id = $1 ORDER BY u.full_name`, [req.params.eventId]);
    res.json({ mc, timer });
  } catch (err) { next(err); }
});

// POST /assign — { role, user_id, event_id }
router.post('/assign', requireRole(...manageRoles), async (req, res, next) => {
  try {
    const { role, user_id, event_id } = req.body;
    if (!EVENT_ROLES.includes(role) || !user_id || !event_id) return res.status(400).json({ error: 'role, user_id, event_id required' });
    const { rows: ev } = await pool.query(`SELECT year_id FROM events WHERE id = $1`, [event_id]);
    if (!ev[0]) return res.status(404).json({ error: 'Event not found' });
    const { rows: u } = await pool.query(`SELECT role FROM users WHERE id = $1`, [user_id]);
    if (!u[0] || u[0].role !== role) return res.status(400).json({ error: `User must hold the ${role} role` });
    try {
      const { rows } = await pool.query(
        `INSERT INTO ${tableFor(role)} (user_id, event_id, year_id, assigned_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [user_id, event_id, ev[0].year_id, req.user.id]);
      await logAudit({ actorId: req.user.id, actorRole: req.user.role,
        action: 'ASSIGN_EVENT_STAFF', entity: tableFor(role), entityId: rows[0].id, details: { role, user_id, event_id } });
      res.status(201).json({ assignment_id: rows[0].id });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: `Already assigned as ${role} for this event` });
      throw e;
    }
  } catch (err) { next(err); }
});

// DELETE /assign/:role/:assignmentId — unassign
router.delete('/assign/:role/:assignmentId', requireRole(...manageRoles), async (req, res, next) => {
  try {
    if (!EVENT_ROLES.includes(req.params.role)) return res.status(400).json({ error: 'bad role' });
    const { rowCount } = await pool.query(`DELETE FROM ${tableFor(req.params.role)} WHERE id = $1`, [req.params.assignmentId]);
    if (!rowCount) return res.status(404).json({ error: 'Assignment not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;

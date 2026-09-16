// src/routes/admin.users.routes.js  (mounted at /api/admin/users)
//
// Staff account management for office/finance users who check registrations
// and confirm payments. Only SuperAdmin and Admin can open this screen.
//
// Roles handled here (office staff only — NOT parents, judges, MC or Timer):
//   SuperAdmin, Admin, Coordinator, Chairman
// Assignable via the UI: Admin, Coordinator, Chairman.
//   • Only a SuperAdmin may create or change an 'Admin' account.
//   • A SuperAdmin account can only be edited by a SuperAdmin.
//   • Parent accounts (role 'Viewer') and event-day accounts (Judge/MC/Timer)
//     are never listed or editable here.
const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

const MANAGE_ROLES = ['SuperAdmin', 'Admin'];          // who can open this screen
const STAFF_ROLES  = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman']; // shown here
const ASSIGNABLE   = ['Admin', 'Coordinator', 'Chairman'];               // pickable in UI

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));

// ── GET /api/admin/users — list office staff accounts ────────────────────────
router.get('/', requireRole(...MANAGE_ROLES), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, email, phone, role, is_active,
              to_char(created_at, 'YYYY-MM-DD') AS created_at
       FROM users
       WHERE role::text = ANY($1)
       ORDER BY (role = 'SuperAdmin') DESC, (role = 'Admin') DESC, full_name`,
      [STAFF_ROLES],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/admin/users — create a staff account ───────────────────────────
router.post('/', requireRole(...MANAGE_ROLES), async (req, res, next) => {
  try {
    const full_name = String(req.body.full_name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').trim() || null;
    const password = String(req.body.password || '');
    const role = String(req.body.role || '');

    if (!full_name || !email || !password)
      return res.status(400).json({ error: 'Full name, email and password are required.' });
    if (!emailOk(email))
      return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!ASSIGNABLE.includes(role))
      return res.status(400).json({ error: `Role must be one of: ${ASSIGNABLE.join(', ')}.` });
    if (role === 'Admin' && req.user.role !== 'SuperAdmin')
      return res.status(403).json({ error: 'Only a SuperAdmin can create an Admin account.' });

    const { rows: exists } = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
    if (exists[0]) return res.status(409).json({ error: 'An account with this email already exists.' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, NOW(), NOW())
       RETURNING id, full_name, email, phone, role, is_active`,
      [full_name, email, phone, hash, role],
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'CREATE_STAFF_USER', entity: 'users', entityId: rows[0].id, details: { role } });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with this email already exists.' });
    next(err);
  }
});

// ── PATCH /api/admin/users/:id — update role / active / name / reset password ─
router.patch('/:id', requireRole(...MANAGE_ROLES), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows: tRows } = await pool.query(
      `SELECT id, full_name, email, role, is_active FROM users WHERE id = $1`, [id]);
    const target = tRows[0];
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (!STAFF_ROLES.includes(target.role))
      return res.status(403).json({ error: 'This screen only manages office staff accounts.' });

    const isSuper = req.user.role === 'SuperAdmin';
    // An Admin cannot touch a SuperAdmin or another Admin — only a SuperAdmin can.
    if (!isSuper && (target.role === 'SuperAdmin' || target.role === 'Admin'))
      return res.status(403).json({ error: 'Only a SuperAdmin can modify Admin or SuperAdmin accounts.' });

    const fields = [];
    const vals = [];
    let i = 1;

    if (req.body.full_name !== undefined) {
      const fn = String(req.body.full_name).trim();
      if (!fn) return res.status(400).json({ error: 'Full name cannot be empty.' });
      fields.push(`full_name = $${i++}`); vals.push(fn);
    }

    if (req.body.role !== undefined) {
      const role = String(req.body.role);
      if (!ASSIGNABLE.includes(role))
        return res.status(400).json({ error: `Role must be one of: ${ASSIGNABLE.join(', ')}.` });
      if (role === 'Admin' && !isSuper)
        return res.status(403).json({ error: 'Only a SuperAdmin can grant the Admin role.' });
      if (id === req.user.id)
        return res.status(400).json({ error: "You can't change your own role." });
      fields.push(`role = $${i++}`); vals.push(role);
    }

    if (req.body.is_active !== undefined) {
      if (id === req.user.id)
        return res.status(400).json({ error: "You can't deactivate your own account." });
      fields.push(`is_active = $${i++}`); vals.push(Boolean(req.body.is_active));
    }

    if (req.body.password !== undefined && req.body.password !== '') {
      const pw = String(req.body.password);
      if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      fields.push(`password_hash = $${i++}`); vals.push(await bcrypt.hash(pw, 10));
    }

    if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE users SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${i} RETURNING id, full_name, email, phone, role, is_active`,
      vals,
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'UPDATE_STAFF_USER', entity: 'users', entityId: id,
      details: { changed: Object.keys(req.body).filter((k) => k !== 'password'),
                 password_reset: req.body.password ? true : undefined } });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;

// src/routes/admin.registrations.routes.js  (mounted at /api/admin/registrations)
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);
const staffRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'];
const editRoles = ['SuperAdmin', 'Admin', 'Coordinator'];

// GET /api/admin/registrations
router.get('/', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { year_id, event_id, status } = req.query;
    const { rows } = await pool.query(
      `SELECT r.*, c.name AS child_name, c.school, e.name AS event_name
       FROM registrations r
       JOIN children c ON c.id = r.child_id
       JOIN events e ON e.id = r.event_id
       WHERE ($1::int IS NULL OR r.year_id = $1)
         AND ($2::int IS NULL OR r.event_id = $2)
         AND ($3::text IS NULL OR r.status = $3)
       ORDER BY r.created_at DESC`,
      [year_id || null, event_id || null, status || null]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/registrations/:id
router.put('/:id', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { status, teacher_name, fee } = req.body;
    const { rows } = await pool.query(
      `UPDATE registrations SET
         status = COALESCE($1, status), teacher_name = COALESCE($2, teacher_name), fee = COALESCE($3, fee)
       WHERE id = $4 RETURNING *`,
      [status, teacher_name, fee, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Registration not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'UPDATE_REGISTRATION', entity: 'registrations', entityId: req.params.id, details: req.body });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/registrations/:id
router.delete('/:id', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM registrations WHERE id = $1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Registration not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'DELETE_REGISTRATION', entity: 'registrations', entityId: req.params.id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/registrations/payments/:id/confirm
router.post('/payments/:id/confirm', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE payments SET status = 'confirmed', confirmed_by = $1, confirmed_at = NOW()
       WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Payment not found' });

    await pool.query(`UPDATE registrations SET status = 'confirmed' WHERE id = $1`, [rows[0].registration_id]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CONFIRM_PAYMENT', entity: 'payments', entityId: req.params.id });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/registrations/refunds/:id/process
router.post('/refunds/:id/process', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { status } = req.body; // 'approved' | 'rejected' | 'paid'
    if (!status) return res.status(400).json({ error: 'status is required' });

    const { rows } = await pool.query(
      `UPDATE refund_log SET status = $1, processed_by = $2, processed_at = NOW()
       WHERE id = $3 RETURNING *`,
      [status, req.user.id, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Refund record not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'PROCESS_REFUND', entity: 'refund_log', entityId: req.params.id, details: { status } });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/registrations/refunds/report
router.get('/refunds/report', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { year_id } = req.query;
    const { rows } = await pool.query(
      `SELECT rl.*, r.event_id, c.name AS child_name
       FROM refund_log rl
       JOIN registrations r ON r.id = rl.registration_id
       JOIN children c ON c.id = r.child_id
       WHERE ($1::int IS NULL OR r.year_id = $1)
       ORDER BY rl.created_at DESC`,
      [year_id || null]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/registrations/export
router.get('/export', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { year_id } = req.query;
    const { rows } = await pool.query(
      `SELECT r.id, c.name AS child_name, c.school, c.age_group, e.name AS event_name,
              r.status, r.teacher_name, r.fee, r.created_at
       FROM registrations r
       JOIN children c ON c.id = r.child_id
       JOIN events e ON e.id = r.event_id
       WHERE ($1::int IS NULL OR r.year_id = $1)
       ORDER BY c.name`,
      [year_id || null]
    );

    const header = 'id,child_name,school,age_group,event_name,status,teacher_name,fee,created_at';
    const csv = [header, ...rows.map((r) =>
      [r.id, r.child_name, r.school, r.age_group, r.event_name, r.status, r.teacher_name, r.fee, r.created_at]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="registrations_export.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

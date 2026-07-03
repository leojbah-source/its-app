// src/routes/admin.payments.routes.js  (mounted at /api/admin)
//
// Payment confirmation and refunds management (Blueprint §4.10, §5.3, §5.4).
//
// DB-verified column names (migration 001_fees_payments_finance.sql):
//   payments: id, year_id, parent_user_id, participant_id, amount,
//             discount_applied, method (enum payment_method), status (enum
//             payment_status: pending|confirmed|rejected), reference,
//             proof_url, notes, confirmed_by, confirmed_at, created_at, updated_at
//   refunds:  id, year_id, participant_id, registration_id, events_withdrawn,
//             reason, original_amount, refund_amount, method,
//             status (pending|confirmed|rejected), refunded_at,
//             requested_by, logged_by, created_at

const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { sendWhatsApp } = require('../utils/notify');

const router = express.Router();
router.use(authenticate);

const staffRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'];
const editRoles = ['SuperAdmin', 'Admin', 'Coordinator'];

function toCsv(rows, columns) {
  const header = columns.join(',');
  const body = rows.map((r) =>
    columns.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(',')
  );
  return [header, ...body].join('\n');
}

// ── GET /api/admin/payments?year_id=&status=&q= ──────────────────────────────
router.get('/payments', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { year_id, status, q } = req.query;
    const { rows } = await pool.query(
      `SELECT pay.*, p.full_name AS participant_name, p.cpr_number,
              u.full_name AS parent_name, cu.full_name AS confirmed_by_name
       FROM payments pay
       LEFT JOIN participants p ON p.id = pay.participant_id
       LEFT JOIN users u ON u.id = pay.parent_user_id
       LEFT JOIN users cu ON cu.id = pay.confirmed_by
       WHERE ($1::int IS NULL OR pay.year_id = $1)
         AND ($2::text IS NULL OR pay.status::text = $2)
         AND ($3::text IS NULL OR p.full_name ILIKE '%' || $3 || '%'
              OR p.cpr_number ILIKE '%' || $3 || '%')
       ORDER BY pay.created_at DESC`,
      [year_id || null, status || null, q || null]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/admin/payments/:id/confirm ─────────────────────────────────────
router.post('/payments/:id/confirm', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE payments SET status = 'confirmed', confirmed_by = $1,
              confirmed_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND status = 'pending' RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Pending payment not found' });

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'CONFIRM_PAYMENT', entity: 'payments', entityId: req.params.id,
      details: { amount: rows[0].amount, method: rows[0].method } });

    // Notify the parent (fire and forget)
    const { rows: pRows } = await pool.query(
      `SELECT full_name, guardian_phone FROM participants WHERE id = $1`,
      [rows[0].participant_id]
    );
    if (pRows[0]?.guardian_phone) {
      sendWhatsApp(pRows[0].guardian_phone,
        `KCA ITS: Payment of BHD ${Number(rows[0].amount).toFixed(3)} for ` +
        `${pRows[0].full_name} is CONFIRMED. Thank you!`
      ).catch(() => null);
    }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/admin/payments/:id/reject ──────────────────────────────────────
router.post('/payments/:id/reject', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: 'reason is required' });
    const { rows } = await pool.query(
      `UPDATE payments SET status = 'rejected', confirmed_by = $1,
              confirmed_at = NOW(), notes = COALESCE(notes || E'\n', '') || 'REJECTED: ' || $2,
              updated_at = NOW()
       WHERE id = $3 AND status = 'pending' RETURNING *`,
      [req.user.id, reason.trim(), req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Pending payment not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'REJECT_PAYMENT', entity: 'payments', entityId: req.params.id,
      details: { reason } });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/admin/refunds?year_id=&status= ──────────────────────────────────
router.get('/refunds', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { year_id, status } = req.query;
    const { rows } = await pool.query(
      `SELECT rf.*, p.full_name AS participant_name, p.cpr_number,
              lu.full_name AS logged_by_name
       FROM refunds rf
       JOIN participants p ON p.id = rf.participant_id
       LEFT JOIN users lu ON lu.id = rf.logged_by
       WHERE ($1::int IS NULL OR rf.year_id = $1)
         AND ($2::text IS NULL OR rf.status = $2)
       ORDER BY rf.created_at DESC`,
      [year_id || null, status || null]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/admin/refunds/:id/confirm ──────────────────────────────────────
// Admin confirms the removal and logs refund amount + method (§5.3).
router.post('/refunds/:id/confirm', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { refund_amount, method, refunded_at } = req.body;
    if (refund_amount == null || !method)
      return res.status(400).json({ error: 'refund_amount and method are required' });

    const { rows } = await pool.query(
      `UPDATE refunds SET status = 'confirmed', refund_amount = $1, method = $2,
              refunded_at = COALESCE($3::date, CURRENT_DATE), logged_by = $4
       WHERE id = $5 AND status = 'pending' RETURNING *`,
      [refund_amount, method, refunded_at || null, req.user.id, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Pending refund not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'CONFIRM_REFUND', entity: 'refunds', entityId: req.params.id,
      details: { refund_amount, method } });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/admin/refunds/:id/reject ───────────────────────────────────────
router.post('/refunds/:id/reject', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE refunds SET status = 'rejected', logged_by = $1
       WHERE id = $2 AND status = 'pending' RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Pending refund not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'REJECT_REFUND', entity: 'refunds', entityId: req.params.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/admin/refunds/export?year_id= ───────────────────────────────────
// Refunds Report (§4.10): participant, events withdrawn, reason, amounts,
// date, method. CSV opens directly in Excel.
router.get('/refunds/export', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { year_id } = req.query;
    const { rows } = await pool.query(
      `SELECT p.full_name AS participant, rf.events_withdrawn, rf.reason,
              rf.original_amount, rf.refund_amount, to_char(rf.refunded_at, 'YYYY-MM-DD') AS date,
              rf.method, rf.status
       FROM refunds rf
       JOIN participants p ON p.id = rf.participant_id
       WHERE ($1::int IS NULL OR rf.year_id = $1)
       ORDER BY rf.created_at`,
      [year_id || null]
    );
    const csv = toCsv(rows, ['participant', 'events_withdrawn', 'reason',
      'original_amount', 'refund_amount', 'date', 'method', 'status']);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="refunds-report.csv"');
    res.send(csv);
  } catch (err) { next(err); }
});

module.exports = router;

// src/routes/admin.security.routes.js  (mounted at /api/admin)
// Read-only security view for senior staff: blocked access attempts and any
// action taken by a parent ('Viewer') account inside the admin area.
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const SECURITY_ROLES = ['SuperAdmin', 'Admin', 'Chairman'];

// GET /api/admin/security/audit
router.get('/security/audit', requireRole(...SECURITY_ROLES), async (req, res, next) => {
  try {
    const { rows: denied } = await pool.query(
      `SELECT a.id, a.changed_at, a.table_name, a.record_id, a.reason,
              a.new_value->>'method' AS method,
              a.new_value->>'path'   AS path,
              COALESCE(a.new_value->>'email', u.email) AS email,
              u.full_name, u.role AS user_role, a.changed_by
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.changed_by
       WHERE a.action = 'ACCESS_DENIED'
       ORDER BY a.changed_at DESC
       LIMIT 300`);

    const { rows: viewerActions } = await pool.query(
      `SELECT a.id, a.changed_at, a.action, a.table_name, a.record_id, a.reason,
              u.full_name, u.email, a.changed_by
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.changed_by
       WHERE a.new_value->>'actor_role' = 'Viewer' AND a.action <> 'ACCESS_DENIED'
       ORDER BY a.changed_at DESC
       LIMIT 300`);

    const { rows: sum } = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM audit_log WHERE action = 'ACCESS_DENIED') AS denied_total,
         (SELECT COUNT(DISTINCT changed_by) FROM audit_log WHERE action = 'ACCESS_DENIED' AND changed_by IS NOT NULL) AS denied_actors,
         (SELECT COUNT(*) FROM audit_log WHERE action = 'ACCESS_DENIED' AND changed_at > NOW() - INTERVAL '24 hours') AS denied_24h,
         (SELECT COUNT(*) FROM audit_log WHERE new_value->>'actor_role' = 'Viewer' AND action <> 'ACCESS_DENIED') AS viewer_actions_total`);

    res.json({ denied, viewer_actions: viewerActions, summary: sum[0] });
  } catch (err) { next(err); }
});

module.exports = router;

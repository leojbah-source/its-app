// src/utils/audit.js
// audit_log is INSERT-ONLY -- never UPDATE or DELETE (Master Context rule #25).
//
// DB-verified columns (schema.sql):
//   table_name, record_id, action, old_value, new_value, changed_by, reason, changed_at
// (The pre-migration-011 version of this file wrote to non-existent columns,
//  so every audit insert silently failed. Migration 011 also drops the
//  INSERT/UPDATE/DELETE-only CHECK so semantic actions can be stored.)
const pool = require('../db');

/**
 * @param {object} p
 * @param {number} [p.actorId]   - user performing the action  → changed_by
 * @param {string} [p.actorRole] - stored inside new_value.actor_role
 * @param {string}  p.action     - e.g. 'CONFIRM_PAYMENT', 'ADMIN_VERIFY_CPR'
 * @param {string}  p.entity     - table/domain name           → table_name
 * @param {number|string} [p.entityId] → record_id
 * @param {object} [p.details]   - after-state / context       → new_value
 * @param {object} [p.before]    - before-state                → old_value
 * @param {string} [p.reason]    - human-readable reason       → reason
 */
async function logAudit({ actorId, actorRole, action, entity, entityId, details, before, reason }) {
  try {
    const newValue = { ...(details || {}), ...(actorRole ? { actor_role: actorRole } : {}) };
    await pool.query(
      `INSERT INTO audit_log (table_name, record_id, action, old_value, new_value, changed_by, reason, changed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [entity, entityId != null ? Number(entityId) : null, action,
       before ? JSON.stringify(before) : null,
       Object.keys(newValue).length ? JSON.stringify(newValue) : null,
       actorId ?? null, reason ?? null]
    );
  } catch (err) {
    // Audit logging must never block the primary action, but we do want to know if it fails.
    console.error('Audit log write failed:', err.message);
  }
}

/**
 * Records a BLOCKED access attempt (forbidden role, or reaching a record that
 * isn't yours) so staff can see who tried what. Best-effort; never blocks the
 * response. Shows up in the audit trail with action 'ACCESS_DENIED'.
 */
// Roles that are legitimate staff. Anyone else (a parent 'Viewer', a 'PWA'
// result-checker, or an unauthenticated token) reaching an admin path, or any
// cross-account access, is treated as a real security event worth an alert.
const STAFF_ROLES_AUDIT = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Registrar', 'Accountant', 'Media'];
const _alertThrottle = new Map();   // actor key -> last alert epoch ms
const ALERT_GAP_MS = 30 * 60 * 1000;

async function logAccessDenied(req, reason, { targetType = 'security', targetId = null, alert } = {}) {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  try {
    await logAudit({
      actorId: req.user?.id ?? null,
      actorRole: req.user?.role ?? 'anonymous',
      action: 'ACCESS_DENIED',
      entity: targetType,
      entityId: targetId,
      details: {
        method: req.method,
        path,
        email: req.user?.email ?? null,
        reason,
      },
      reason,
    });
  } catch (e) { /* best-effort */ }
  console.warn(`[ACCESS_DENIED] user=${req.user?.id ?? '-'} role=${req.user?.role ?? '-'} ${req.method} ${path} :: ${reason}`);

  // Decide whether to raise an alert. Default: a non-staff account reaching an
  // admin path. Callers can force it (e.g. a cross-account record access).
  const isStaff = STAFF_ROLES_AUDIT.includes(req.user?.role);
  const shouldAlert = alert !== undefined ? alert : (path.startsWith('/api/admin') && !isStaff);
  if (shouldAlert) sendSecurityAlert(req, reason, path).catch(() => {});
}

// Throttled WhatsApp + email to SuperAdmins when a blocked attempt looks like
// someone reaching beyond their permissions. Best-effort; never blocks.
async function sendSecurityAlert(req, reason, path) {
  const key = String(req.user?.id || req.ip || 'anon');
  const now = Date.now();
  if (now - (_alertThrottle.get(key) || 0) < ALERT_GAP_MS) return;
  _alertThrottle.set(key, now);

  const who = req.user?.email || `user#${req.user?.id || '?'}` || 'anonymous';
  const role = req.user?.role || 'anonymous';
  const when = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bahrain' });
  const msg = `⚠️ KCA ITS security alert
${who} (role: ${role}) was BLOCKED trying ${req.method} ${path}.
${reason}
${when} (Bahrain). Open Admin → Security for details.`;

  try {
    const pool = require('../db');
    const { rows } = await pool.query(
      `SELECT phone, email FROM users WHERE role = 'SuperAdmin' AND is_active = TRUE`);
    const phones = rows.map((r) => r.phone).filter(Boolean);
    const emails = rows.map((r) => r.email).filter(Boolean);
    if (phones.length) {
      const { sendWhatsAppMany } = require('./notify');
      sendWhatsAppMany(phones, msg).catch(() => {});
    }
    if (emails.length) {
      const { sendEmail } = require('./email');
      for (const to of emails) {
        sendEmail({ to, subject: 'KCA ITS — security alert (blocked access)',
          html: `<p>${msg.replace(/\n/g, '<br>')}</p>` }).catch(() => {});
      }
    }
  } catch (e) { console.error('security alert failed:', e.message); }
}

module.exports = { logAudit, logAccessDenied, sendSecurityAlert };

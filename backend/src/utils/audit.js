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

module.exports = { logAudit };

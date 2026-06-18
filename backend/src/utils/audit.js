// src/utils/audit.js
// audit_log is INSERT-ONLY -- never UPDATE or DELETE (Master Context rule #25).
const pool = require('../db');

async function logAudit({ actorId, actorRole, action, entity, entityId, details }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (actor_id, actor_role, action, entity, entity_id, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [actorId ?? null, actorRole ?? null, action, entity, entityId ?? null, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    // Audit logging must never block the primary action, but we do want to know if it fails.
    console.error('Audit log write failed:', err.message);
  }
}

module.exports = { logAudit };

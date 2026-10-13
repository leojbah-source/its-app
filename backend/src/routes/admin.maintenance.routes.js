// src/routes/admin.maintenance.routes.js  (mounted at /api/admin/maintenance)
//
// SuperAdmin-only data maintenance. Currently: convert participant names to
// UPPERCASE for the active year, with an automatic in-transaction backup of the
// original names (participant_name_backup) so the change is fully reversible.
// Every action is idempotent and audited; nothing else is touched.

const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

async function activeYearId(db = pool) {
  const { rows } = await db.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
  return rows[0]?.id || null;
}

// ── GET /names-status ─────────────────────────────────────────────────────────
router.get('/names-status', requireRole('SuperAdmin'), async (req, res, next) => {
  try {
    const yid = await activeYearId();
    if (!yid) return res.status(400).json({ error: 'No active year' });
    const { rows: tc } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM participants
        WHERE year_id = $1 AND full_name IS NOT NULL AND full_name <> UPPER(full_name)`, [yid]);
    const { rows: bk } = await pool.query(`SELECT to_regclass('public.participant_name_backup') AS t`);
    let backup_rows = 0;
    if (bk[0].t) {
      const { rows: bc } = await pool.query(`SELECT COUNT(*)::int AS c FROM participant_name_backup`);
      backup_rows = bc[0].c;
    }
    res.json({ to_change: tc[0].c, backup_rows, backup_exists: !!bk[0].t });
  } catch (err) { next(err); }
});

// ── POST /uppercase-names ─────────────────────────────────────────────────────
// Back up (original name per changed participant) then UPPERCASE, in ONE
// transaction. Idempotent: a second run changes nothing. Active year only.
router.post('/uppercase-names', requireRole('SuperAdmin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const yid = await activeYearId(client);
    if (!yid) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No active year' }); }

    await client.query(
      `CREATE TABLE IF NOT EXISTS participant_name_backup (
         participant_id INTEGER PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
         old_name       TEXT NOT NULL,
         backed_up_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         backed_up_by   INTEGER REFERENCES users(id) )`);

    // Back up the ORIGINAL name of every participant we are about to change
    // (first write wins — a re-run never overwrites the true original).
    await client.query(
      `INSERT INTO participant_name_backup (participant_id, old_name, backed_up_by)
       SELECT id, full_name, $2 FROM participants
        WHERE year_id = $1 AND full_name IS NOT NULL AND full_name <> UPPER(full_name)
       ON CONFLICT (participant_id) DO NOTHING`, [yid, req.user.id]);

    const { rowCount } = await client.query(
      `UPDATE participants SET full_name = UPPER(full_name), updated_at = NOW()
        WHERE year_id = $1 AND full_name IS NOT NULL AND full_name <> UPPER(full_name)`, [yid]);

    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'UPPERCASE_PARTICIPANT_NAMES',
      entity: 'participants', entityId: null, details: { changed: rowCount, year_id: yid } });

    res.json({ ok: true, changed: rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── POST /restore-names ───────────────────────────────────────────────────────
// Restore original participant names from the backup table.
router.post('/restore-names', requireRole('SuperAdmin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: bk } = await client.query(`SELECT to_regclass('public.participant_name_backup') AS t`);
    if (!bk[0].t) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No backup found to restore from.' }); }

    const { rowCount } = await client.query(
      `UPDATE participants p SET full_name = b.old_name, updated_at = NOW()
         FROM participant_name_backup b
        WHERE b.participant_id = p.id AND p.full_name <> b.old_name`);

    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'RESTORE_PARTICIPANT_NAMES',
      entity: 'participants', entityId: null, details: { restored: rowCount } });

    res.json({ ok: true, restored: rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

module.exports = router;

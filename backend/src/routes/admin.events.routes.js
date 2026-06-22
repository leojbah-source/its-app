// src/routes/admin.events.routes.js  (mounted at /api/admin)
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { sendWhatsApp } = require('../utils/notify');

const router = express.Router();
router.use(authenticate);

const staffRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'];
const editRoles  = ['SuperAdmin', 'Admin', 'Coordinator'];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function attachCriteriaAndAgeGroups(client, rows) {
  if (!rows.length) return rows;
  const eventIds = rows.map((r) => r.id);

  const { rows: criteriaRows } = await client.query(
    `SELECT event_id, criterion_name AS label, max_score, sequence_order
     FROM event_criteria WHERE event_id = ANY($1)
     ORDER BY event_id, sequence_order`,
    [eventIds],
  );

  const { rows: agRows } = await client.query(
    `SELECT eag.event_id, ag.code
     FROM event_age_groups eag
     JOIN age_groups ag ON ag.id = eag.age_group_id
     WHERE eag.event_id = ANY($1)
     ORDER BY eag.event_id, ag.sort_order`,
    [eventIds],
  );

  const criteriaMap = {};
  for (const c of criteriaRows) {
    if (!criteriaMap[c.event_id]) criteriaMap[c.event_id] = [];
    criteriaMap[c.event_id].push({ label: c.label, max_score: Number(c.max_score) });
  }

  const ageGroupMap = {};
  for (const ag of agRows) {
    if (!ageGroupMap[ag.event_id]) ageGroupMap[ag.event_id] = [];
    ageGroupMap[ag.event_id].push(ag.code);
  }

  rows.forEach((row) => {
    row.criteria   = criteriaMap[row.id]   || [];
    row.age_groups = ageGroupMap[row.id]   || [];
  });

  return rows;
}

async function saveCriteria(client, eventId, criteria) {
  await client.query(`DELETE FROM event_criteria WHERE event_id = $1`, [eventId]);
  for (const [i, c] of (criteria || []).entries()) {
    if (c.label?.trim()) {
      await client.query(
        `INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
         VALUES ($1, $2, $3, $4)`,
        [eventId, c.label.trim(), Number(c.max_score) || 0, i + 1],
      );
    }
  }
}

async function saveAgeGroups(client, eventId, yearId, agCodes) {
  await client.query(`DELETE FROM event_age_groups WHERE event_id = $1`, [eventId]);
  if (!agCodes?.length) return;
  const { rows: agRows } = await client.query(
    `SELECT id FROM age_groups WHERE year_id = $1 AND code = ANY($2)`,
    [yearId, agCodes],
  );
  for (const ag of agRows) {
    await client.query(
      `INSERT INTO event_age_groups (event_id, age_group_id) VALUES ($1, $2)`,
      [eventId, ag.id],
    );
  }
}

// ── GET /api/admin/categories ────────────────────────────────────────────────
router.get('/categories', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows: config } = await pool.query(
      `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    if (!config[0]) return res.json([]);
    const { rows } = await pool.query(
      `SELECT id, code, name, sort_order FROM categories
       WHERE year_id = $1 ORDER BY sort_order, id`,
      [config[0].id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/events ────────────────────────────────────────────────────
router.get('/events', requireRole(...staffRoles), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows: config } = await client.query(
      `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    const year_id = config[0]?.id || null;

    const { rows } = await client.query(
      `SELECT e.*, c.name AS category_name, c.code AS category_code
       FROM events e
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE ($1::int IS NULL OR e.year_id = $1)
       ORDER BY c.sort_order, e.sort_order, e.id`,
      [year_id],
    );

    await attachCriteriaAndAgeGroups(client, rows);
    res.json(rows);
  } catch (err) { next(err); }
  finally { client.release(); }
});

// ── GET /api/admin/events/:id ────────────────────────────────────────────────
router.get('/events/:id', requireRole(...staffRoles), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT e.*, c.name AS category_name, c.code AS category_code
       FROM events e
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE e.id = $1`,
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Event not found' });
    await attachCriteriaAndAgeGroups(client, rows);
    res.json(rows[0]);
  } catch (err) { next(err); }
  finally { client.release(); }
});

// ── POST /api/admin/events ───────────────────────────────────────────────────
router.post('/events', requireRole(...editRoles), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      event_code, event_name, category_id,
      event_kind     = 'individual',
      is_stage_event = false,
      time_slot_mode = false,
      criteria       = [],
      age_groups     = [],
    } = req.body;

    if (!event_code || !event_name || !category_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'event_code, event_name, category_id are required' });
    }

    const { rows: cfg } = await client.query(
      `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    if (!cfg[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No active year config' }); }
    const year_id = cfg[0].id;

    const { rows } = await client.query(
      `INSERT INTO events
         (year_id, category_id, event_code, event_name, event_kind,
          is_stage_event, time_slot_mode, sort_order, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,NOW(),NOW()) RETURNING *`,
      [year_id, category_id, event_code, event_name, event_kind, is_stage_event, time_slot_mode],
    );
    const eventId = rows[0].id;

    await saveCriteria(client, eventId, criteria);
    await saveAgeGroups(client, eventId, year_id, age_groups);

    await client.query('COMMIT');

    rows[0].criteria   = criteria.filter((c) => c.label?.trim()).map((c) => ({ label: c.label, max_score: Number(c.max_score) || 0 }));
    rows[0].age_groups = age_groups;

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'CREATE_EVENT', entity: 'events', entityId: eventId });
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── PUT /api/admin/events/:id ────────────────────────────────────────────────
router.put('/events/:id', requireRole(...editRoles), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      event_code, event_name, category_id, event_kind,
      is_stage_event, time_slot_mode,
      criteria, age_groups,
    } = req.body;

    const { rows } = await client.query(
      `UPDATE events SET
         event_code     = COALESCE($1, event_code),
         event_name     = COALESCE($2, event_name),
         category_id    = COALESCE($3, category_id),
         event_kind     = COALESCE($4, event_kind),
         is_stage_event = COALESCE($5, is_stage_event),
         time_slot_mode = COALESCE($6, time_slot_mode),
         updated_at     = NOW()
       WHERE id = $7 RETURNING *`,
      [event_code, event_name, category_id, event_kind, is_stage_event, time_slot_mode, req.params.id],
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found' }); }

    if (Array.isArray(criteria))   await saveCriteria(client, req.params.id, criteria);
    if (Array.isArray(age_groups)) await saveAgeGroups(client, req.params.id, rows[0].year_id, age_groups);

    await client.query('COMMIT');

    rows[0].criteria   = Array.isArray(criteria)   ? criteria.filter((c) => c.label?.trim())   : [];
    rows[0].age_groups = Array.isArray(age_groups) ? age_groups : [];

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'UPDATE_EVENT', entity: 'events', entityId: req.params.id, details: req.body });
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── DELETE /api/admin/events/:id ─────────────────────────────────────────────
router.delete('/events/:id', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM events WHERE id = $1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Event not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'DELETE_EVENT', entity: 'events', entityId: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── POST /api/admin/events/:id/cancel ────────────────────────────────────────
router.post('/events/:id/cancel', requireRole('SuperAdmin', 'Admin', 'Chairman'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: evRows } = await client.query(
      `UPDATE events SET is_cancelled = TRUE, cancelled_at = NOW(),
        cancel_reason = $2, cancelled_by = $3
       WHERE id = $1 RETURNING *`,
      [req.params.id, req.body.reason || null, req.user.id],
    );
    if (!evRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found' }); }

    const { rows: affected } = await client.query(
      `SELECT r.id AS registration_id, c.name AS child_name, u.email, c.parent_user_id
       FROM registrations r
       JOIN children c ON c.id = r.child_id
       LEFT JOIN users u ON u.id = c.parent_user_id
       WHERE r.event_id = $1 AND r.status != 'cancelled'`,
      [req.params.id],
    );
    await client.query(
      `UPDATE registrations SET status = 'cancelled_event' WHERE event_id = $1`, [req.params.id],
    );
    await client.query('COMMIT');

    for (const reg of affected) {
      await sendWhatsApp(reg.phone,
        `${evRows[0].event_name} has been cancelled. You may use the swap window to pick a replacement event.`,
      ).catch(() => null);
    }
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'CANCEL_EVENT', entity: 'events', entityId: req.params.id,
      details: { affectedCount: affected.length } });
    res.json({ event: evRows[0], affectedRegistrations: affected.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

module.exports = router;
// src/routes/admin.registrations.routes.js  (mounted at /api/admin)
//
// DB-verified column names:
//   participants:  id, year_id, school_id, cpr_number, full_name, dob, gender,
//                  age_group_id, guardian_name, guardian_phone, membership_status
//   registrations: id, year_id, participant_id, team_id, event_id, age_group_id,
//                  category_id, status (enum: registered|attended|absent|withdrawn|swapped),
//                  dance_teacher, music_teacher, registered_at, registered_by, updated_at
//   teams:         id, year_id, event_id, school_id, age_group_id, team_name
//   team_members:  id, team_id, participant_id, is_substitute, attendance_confirmed
//   schools:       id, name, short_code, is_active
//   age_groups:    id, year_id, code, label, sort_order
//   categories:    id, year_id, code, name, sort_order
//   events:        id, year_id, event_name, event_code, event_kind, category_id
//
// NOTE: No payments or refund_log tables exist — payment tracking not included.

const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

const staffRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'];
const editRoles  = ['SuperAdmin', 'Admin', 'Coordinator'];

// ── IMPORTANT: static paths must come before /:id ────────────────────────────

// ── GET /api/admin/registrations/summary ─────────────────────────────────────
// Per-event registration counts — used for split/merge monitoring dashboard.
router.get('/registrations/summary', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows: cfg } = await pool.query(
      `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    if (!cfg[0]) return res.json([]);
    const year_id = cfg[0].id;

    const { rows } = await pool.query(
      `SELECT
         e.id AS event_id, e.event_name, e.event_code, e.event_kind,
         ag.code AS age_group_code, ag.label AS age_group_label,
         COUNT(r.id)                                                    AS total,
         COUNT(r.id) FILTER (WHERE r.status = 'registered')            AS registered,
         COUNT(r.id) FILTER (WHERE r.status = 'attended')              AS attended,
         COUNT(r.id) FILTER (WHERE r.status = 'absent')                AS absent,
         COUNT(r.id) FILTER (WHERE r.status = 'withdrawn')             AS withdrawn
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       WHERE r.year_id = $1
       GROUP BY e.id, e.event_name, e.event_code, e.event_kind,
                ag.code, ag.label, ag.sort_order
       ORDER BY e.event_name, ag.sort_order`,
      [year_id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/registrations/export ──────────────────────────────────────
// Full CSV export of registrations for the active year.
router.get('/registrations/export', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows: cfg } = await pool.query(
      `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    const year_id = cfg[0]?.id || null;

    const { rows } = await pool.query(
      `SELECT
         p.full_name AS participant_name, p.cpr_number, p.gender, p.dob,
         s.name AS school_name,
         ag.code AS age_group_code,
         e.event_code, e.event_name, e.event_kind,
         c.name AS category_name,
         r.status, r.dance_teacher, r.music_teacher, r.registered_at
       FROM registrations r
       JOIN participants p ON p.id = r.participant_id
       LEFT JOIN schools s ON s.id = p.school_id
       JOIN events e ON e.id = r.event_id
       LEFT JOIN categories c ON c.id = r.category_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       WHERE ($1::int IS NULL OR r.year_id = $1)
       ORDER BY p.full_name, e.event_name`,
      [year_id],
    );

    const header = 'Participant,CPR,Gender,DOB,School,Age Group,Event Code,Event,Type,Category,Status,Dance Teacher,Music Teacher,Registered At';
    const csv = [
      header,
      ...rows.map((r) =>
        [r.participant_name, r.cpr_number, r.gender, r.dob, r.school_name,
         r.age_group_code, r.event_code, r.event_name, r.event_kind,
         r.category_name, r.status, r.dance_teacher, r.music_teacher, r.registered_at]
          .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="registrations_export.csv"');
    res.send(csv);
  } catch (err) { next(err); }
});

// ── GET /api/admin/participants ───────────────────────────────────────────────
// List participants for the active year with registration counts.
router.get('/participants', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { search, school_id, age_group_id } = req.query;
    const { rows: cfg } = await pool.query(
      `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    const year_id = cfg[0]?.id || null;

    const { rows } = await pool.query(
      `SELECT
         p.id, p.cpr_number, p.full_name, p.dob, p.gender, p.membership_status,
         p.guardian_name, p.guardian_phone,
         s.name AS school_name,
         ag.code AS age_group_code, ag.label AS age_group_label,
         COUNT(r.id) FILTER (WHERE r.status != 'withdrawn') AS event_count
       FROM participants p
       LEFT JOIN schools s ON s.id = p.school_id
       LEFT JOIN age_groups ag ON ag.id = p.age_group_id
       LEFT JOIN registrations r ON r.participant_id = p.id
       WHERE ($1::int IS NULL OR p.year_id = $1)
         AND ($2::text IS NULL OR p.full_name ILIKE '%' || $2 || '%'
              OR p.cpr_number = $2)
         AND ($3::int IS NULL OR p.school_id = $3)
         AND ($4::int IS NULL OR p.age_group_id = $4)
       GROUP BY p.id, s.name, ag.code, ag.label, ag.sort_order
       ORDER BY p.full_name`,
      [year_id,
       search || null,
       school_id ? parseInt(school_id, 10) : null,
       age_group_id ? parseInt(age_group_id, 10) : null],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/registrations ─────────────────────────────────────────────
// List all registrations for the active year with full joined data.
router.get('/registrations', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { event_id, status, age_group_id, search } = req.query;
    const { rows: cfg } = await pool.query(
      `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    const year_id = cfg[0]?.id || null;

    const { rows } = await pool.query(
      `SELECT
         r.id, r.year_id, r.participant_id, r.event_id, r.team_id,
         r.age_group_id, r.category_id, r.status,
         r.dance_teacher, r.music_teacher, r.registered_at, r.updated_at,
         p.full_name AS participant_name, p.cpr_number, p.gender, p.dob,
         s.name AS school_name,
         e.event_name, e.event_code, e.event_kind,
         c.name AS category_name,
         ag.code AS age_group_code, ag.label AS age_group_label
       FROM registrations r
       JOIN participants p ON p.id = r.participant_id
       LEFT JOIN schools s ON s.id = p.school_id
       JOIN events e ON e.id = r.event_id
       LEFT JOIN categories c ON c.id = r.category_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       WHERE ($1::int IS NULL OR r.year_id = $1)
         AND ($2::int IS NULL OR r.event_id = $2)
         AND ($3::text IS NULL OR r.status::text = $3)
         AND ($4::int IS NULL OR r.age_group_id = $4)
         AND ($5::text IS NULL
              OR p.full_name ILIKE '%' || $5 || '%'
              OR p.cpr_number = $5)
       ORDER BY p.full_name, r.registered_at`,
      [year_id,
       event_id ? parseInt(event_id, 10) : null,
       status || null,
       age_group_id ? parseInt(age_group_id, 10) : null,
       search || null],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/registrations/:id ─────────────────────────────────────────
router.get('/registrations/:id', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         r.*,
         p.full_name AS participant_name, p.cpr_number, p.dob, p.gender,
         p.guardian_name, p.guardian_phone,
         s.name AS school_name,
         e.event_name, e.event_code, e.event_kind,
         c.name AS category_name,
         ag.code AS age_group_code, ag.label AS age_group_label
       FROM registrations r
       JOIN participants p ON p.id = r.participant_id
       LEFT JOIN schools s ON s.id = p.school_id
       JOIN events e ON e.id = r.event_id
       LEFT JOIN categories c ON c.id = r.category_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       WHERE r.id = $1`,
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Registration not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── PUT /api/admin/registrations/:id ─────────────────────────────────────────
// Admin can update status, dance_teacher, music_teacher.
router.put('/registrations/:id', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { status, dance_teacher, music_teacher } = req.body;
    const { rows } = await pool.query(
      `UPDATE registrations SET
         status        = COALESCE($1::registration_status, status),
         dance_teacher = COALESCE($2, dance_teacher),
         music_teacher = COALESCE($3, music_teacher),
         updated_at    = NOW()
       WHERE id = $4
       RETURNING *`,
      [status || null, dance_teacher || null, music_teacher || null, req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Registration not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'UPDATE_REGISTRATION', entity: 'registrations',
      entityId: req.params.id, details: req.body });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/registrations/:id ──────────────────────────────────────
router.delete('/registrations/:id', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM registrations WHERE id = $1`, [req.params.id],
    );
    if (!rowCount) return res.status(404).json({ error: 'Registration not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'DELETE_REGISTRATION', entity: 'registrations', entityId: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── GET /api/admin/teams ──────────────────────────────────────────────────────
// List team registrations for the active year.
router.get('/teams', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows: cfg } = await pool.query(
      `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    const year_id = cfg[0]?.id || null;

    const { rows } = await pool.query(
      `SELECT
         t.id, t.team_name, t.year_id, t.event_id,
         e.event_name, e.event_code,
         s.name AS school_name,
         ag.code AS age_group_code, ag.label AS age_group_label,
         COUNT(tm.id) AS member_count
       FROM teams t
       JOIN events e ON e.id = t.event_id
       LEFT JOIN schools s ON s.id = t.school_id
       LEFT JOIN age_groups ag ON ag.id = t.age_group_id
       LEFT JOIN team_members tm ON tm.team_id = t.id
       WHERE ($1::int IS NULL OR t.year_id = $1)
       GROUP BY t.id, e.event_name, e.event_code, s.name, ag.code, ag.label
       ORDER BY t.team_name`,
      [year_id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/teams/:id/members ─────────────────────────────────────────
router.get('/teams/:id/members', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT tm.*, p.full_name, p.cpr_number, p.dob, p.gender,
              s.name AS school_name,
              ag.code AS age_group_code
       FROM team_members tm
       JOIN participants p ON p.id = tm.participant_id
       LEFT JOIN schools s ON s.id = p.school_id
       LEFT JOIN age_groups ag ON ag.id = p.age_group_id
       WHERE tm.team_id = $1
       ORDER BY p.full_name`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/schools ────────────────────────────────────────────────────
// Lookup list for school filter dropdowns.
router.get('/schools', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, short_code FROM schools WHERE is_active = TRUE ORDER BY name`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;

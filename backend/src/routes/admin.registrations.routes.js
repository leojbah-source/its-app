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
const { sendWhatsApp } = require('../utils/notify');
const { sendEmail } = require('../utils/email');

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
         p.cpr_verified_method,
         (SELECT string_agg(DISTINCT pay.method::text, ',')
          FROM payments pay
          WHERE (r.participant_id IS NOT NULL AND pay.participant_id = r.participant_id)
             OR (r.team_id IS NOT NULL AND pay.team_id = r.team_id)) AS payment_methods,
         (SELECT pu.membership_status FROM users pu
          WHERE pu.id = p.created_by) AS parent_membership_status,
         t.team_name,
         (SELECT COUNT(*)::int FROM team_members tm WHERE tm.team_id = r.team_id) AS team_member_count,
         s.name AS school_name,
         e.event_name, e.event_code, e.event_kind,
         c.name AS category_name,
         ag.code AS age_group_code, ag.label AS age_group_label
       FROM registrations r
       LEFT JOIN participants p ON p.id = r.participant_id
       LEFT JOIN teams t ON t.id = r.team_id
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
    const { rows: documents } = await pool.query(
      `SELECT td.id, td.url, td.original_name, td.uploaded_at, u.full_name AS uploaded_by_name
       FROM team_documents td LEFT JOIN users u ON u.id = td.uploaded_by
       WHERE td.team_id = $1 ORDER BY td.uploaded_at`, [req.params.id]);
    res.json({ members: rows, documents });
  } catch (err) { next(err); }
});

// ── Participant verification (View drawer) ───────────────────────────────────

// GET /api/admin/participants/:id/detail — everything the admin needs to
// verify a participant: identity + scans, registrations, payments, audit.
router.get('/participants/:id/detail', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows: pRows } = await pool.query(
      `SELECT p.*, s.name AS school_name, ag.code AS age_group_code, ag.label AS age_group_label,
              u.full_name AS parent_name, u.email AS parent_email, u.phone AS parent_phone,
              u.whatsapp_number AS parent_whatsapp, u.membership_status AS parent_membership_status,
              vu.full_name AS admin_verified_by_name
       FROM participants p
       LEFT JOIN schools s ON s.id = p.school_id
       LEFT JOIN age_groups ag ON ag.id = p.age_group_id
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN users vu ON vu.id = p.admin_verified_by
       WHERE p.id = $1`, [req.params.id]);
    if (!pRows[0]) return res.status(404).json({ error: 'Participant not found' });

    const { rows: regs } = await pool.query(
      `SELECT r.id, r.event_id, r.status, r.fee_amount, r.dance_teacher, r.music_teacher,
              e.event_code, e.event_name, c.name AS category_name
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE r.participant_id = $1 ORDER BY e.event_code`, [req.params.id]);

    const { rows: payments } = await pool.query(
      `SELECT id, amount, method, status, reference, proof_url, notes, created_at, confirmed_at
       FROM payments WHERE participant_id = $1 ORDER BY created_at`, [req.params.id]);

    const { rows: audit } = await pool.query(
      `SELECT a.id, a.table_name, a.record_id, a.action, a.old_value, a.new_value,
              a.reason, a.changed_at, u.full_name AS changed_by_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.changed_by
       WHERE (a.table_name = 'participants' AND a.record_id = $1)
          OR (a.table_name = 'payments' AND a.record_id IN (SELECT id FROM payments WHERE participant_id = $1))
          OR (a.table_name = 'registrations' AND a.record_id IN (SELECT id FROM registrations WHERE participant_id = $1))
       ORDER BY a.changed_at DESC LIMIT 50`, [req.params.id]);

    res.json({ participant: pRows[0], registrations: regs, payments, audit });
  } catch (err) { next(err); }
});

// POST /api/admin/participants/:id/verify — mark CPR/identity verified, or
// flag an issue (mandatory note) which notifies the parent to correct it.
router.post('/participants/:id/verify', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { status, note } = req.body;
    if (!['verified', 'issue'].includes(status))
      return res.status(400).json({ error: "status must be 'verified' or 'issue'" });
    if (status === 'issue' && !note?.trim())
      return res.status(400).json({ error: 'A note describing the issue is required' });

    const { rows: before } = await pool.query(
      `SELECT admin_verified_status, admin_verify_note FROM participants WHERE id = $1`, [req.params.id]);
    if (!before[0]) return res.status(404).json({ error: 'Participant not found' });

    const { rows } = await pool.query(
      `UPDATE participants SET
         admin_verified_status = $1,
         admin_verified_by = $2,
         admin_verified_at = NOW(),
         admin_verify_note = $3,
         updated_at = NOW()
       WHERE id = $4
       RETURNING id, full_name, guardian_phone, created_by,
                 admin_verified_status, admin_verify_note`, 
      [status, req.user.id, note?.trim() || null, req.params.id]);
    const p = rows[0];

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'ADMIN_VERIFY_CPR', entity: 'participants', entityId: p.id,
      before: before[0],
      details: { admin_verified_status: status, note: note?.trim() || null },
      reason: note?.trim() || 'CPR/identity check' });

    // Notify the parent when an issue is flagged so they can correct it
    let notified = false;
    if (status === 'issue') {
      if (p.guardian_phone) {
        sendWhatsApp(p.guardian_phone,
          `KCA ITS: A problem was found while verifying ${p.full_name}'s CPR details: ` +
          `"${note.trim()}". Please open the registration portal and correct the details.`)
          .catch(() => null);
        notified = true;
      }
      const { rows: u } = await pool.query(`SELECT email FROM users WHERE id = $1`, [p.created_by]);
      if (u[0]?.email) {
        sendEmail({
          to: u[0].email,
          subject: `KCA ITS — Action needed: ${p.full_name}'s CPR details`,
          html: `<p>Dear parent,</p><p>While verifying <b>${p.full_name}</b>'s registration we found:</p>
                 <blockquote>${note.trim()}</blockquote>
                 <p>Please sign in to the registration portal, open your child's page and correct the
                 details (you can re-scan the CPR card there). The registration will be re-verified after
                 your update.</p><p>— KCA Indian Talent Scan</p>`,
        }).catch(() => null);
        notified = true;
      }
    }
    res.json({ ...p, parent_notified: notified });
  } catch (err) { next(err); }
});

// PUT /api/admin/participants/:id/events — CHAIRMAN-ONLY event corrections
// (add/remove regardless of parent deadlines). Fully audited before/after.
router.put('/participants/:id/events', requireRole('Chairman', 'SuperAdmin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { add_event_ids = [], remove_event_ids = [], reason } = req.body;
    if (!reason?.trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A reason is required for event corrections' });
    }

    const { rows: pRows } = await client.query(
      `SELECT p.*, u.membership_status AS parent_membership
       FROM participants p LEFT JOIN users u ON u.id = p.created_by
       WHERE p.id = $1`, [req.params.id]);
    const p = pRows[0];
    if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Participant not found' }); }

    const { rows: beforeRegs } = await client.query(
      `SELECT e.event_code FROM registrations r JOIN events e ON e.id = r.event_id
       WHERE r.participant_id = $1 AND r.status NOT IN ('withdrawn','swapped')
       ORDER BY e.event_code`, [req.params.id]);

    const memberActive = p.parent_membership === 'active';
    const added = [], removed = [];

    for (const eventId of remove_event_ids) {
      const { rows } = await client.query(
        `UPDATE registrations r SET status = 'withdrawn', updated_at = NOW()
         FROM events e
         WHERE r.participant_id = $1 AND r.event_id = $2 AND r.status = 'registered' AND e.id = r.event_id
         RETURNING r.id, r.fee_amount, e.event_code, e.event_name`,
        [req.params.id, eventId]);
      for (const reg of rows) {
        await client.query(
          `INSERT INTO refunds (year_id, participant_id, registration_id, events_withdrawn,
                                reason, original_amount, refund_amount, status, requested_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
          [p.year_id, p.id, reg.id, `${reg.event_code} — ${reg.event_name}`,
           `Chairman correction: ${reason.trim()}`, reg.fee_amount || 0, reg.fee_amount || 0, req.user.id]);
        removed.push(reg.event_code);
      }
    }

    for (const eventId of add_event_ids) {
      const { rows: ev } = await client.query(
        `SELECT e.id, e.category_id, e.fee_amount, e.member_fee_amount, e.event_code
         FROM events e JOIN event_age_groups eag ON eag.event_id = e.id
         WHERE e.id = $1 AND eag.age_group_id = $2 AND e.is_cancelled = FALSE
           AND e.event_kind = 'individual'`,
        [eventId, p.age_group_id]);
      if (!ev[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Event ${eventId} is not eligible for this participant` }); }
      const { rows: dup } = await client.query(
        `SELECT 1 FROM registrations WHERE participant_id = $1 AND event_id = $2 AND status != 'withdrawn'`,
        [p.id, eventId]);
      if (dup[0]) continue;
      const fee = memberActive && ev[0].member_fee_amount != null
        ? Number(ev[0].member_fee_amount) : Number(ev[0].fee_amount || 0);
      await client.query(
        `INSERT INTO registrations (year_id, participant_id, event_id, age_group_id, category_id,
                                    fee_amount, status, registered_by, registered_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'registered',$7,NOW(),NOW())`,
        [p.year_id, p.id, eventId, p.age_group_id, ev[0].category_id, fee, req.user.id]);
      added.push(ev[0].event_code);
    }

    const { rows: afterRegs } = await client.query(
      `SELECT e.event_code FROM registrations r JOIN events e ON e.id = r.event_id
       WHERE r.participant_id = $1 AND r.status NOT IN ('withdrawn','swapped')
       ORDER BY e.event_code`, [req.params.id]);

    await client.query('COMMIT');

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'CHAIRMAN_EVENT_CORRECTION', entity: 'participants', entityId: p.id,
      before: { events: beforeRegs.map((r) => r.event_code) },
      details: { events: afterRegs.map((r) => r.event_code), added, removed },
      reason: reason.trim() });

    res.json({ added, removed, events: afterRegs.map((r) => r.event_code) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
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

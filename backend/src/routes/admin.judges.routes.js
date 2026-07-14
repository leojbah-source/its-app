// src/routes/admin.judges.routes.js  (mounted at /api/admin/judges)
// Judge profiles, blacklist (rule #10), manual OTP (rule #12) and event
// assignment (≈3 judges per event). Contact fields (phone/whatsapp/email) are
// restricted to SuperAdmin/Chairman (rule #11) — everyone else gets the public
// projection (v_judges_public equivalent) plus a has_contact flag.
//
// Real schema (verified):
//   judges(id, user_id, full_name, phone, whatsapp, email, bio,
//          is_blacklisted, blacklist_reason, blacklist_date, blacklisted_by,
//          otp_code, otp_sent_at, otp_sent_by, created_at, updated_at)
//   judge_assignments(id, judge_id, event_id, time_slot_id, assigned_by,
//          assigned_at, UNIQUE(judge_id, event_id, time_slot_id))
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { createOtp } = require('../utils/otp');
const { sendWhatsApp } = require('../utils/notify');

const router = express.Router();
router.use(authenticate);

const staffRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'];
const manageRoles = ['SuperAdmin', 'Chairman'];            // create/edit/blacklist
const assignRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman'];
const canSeeContact = (role) => role === 'SuperAdmin' || role === 'Chairman';

const n = (v) => (v === '' || v === undefined || v === null ? null : v);
// expertise arrives as an array of category codes; null = leave untouched.
const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : null);

// ── GET /api/admin/judges — list with assignment counts ──────────────────────
// Public projection for all staff; contact fields only for SuperAdmin/Chairman.
router.get('/', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const withContact = canSeeContact(req.user.role);
    const { rows } = await pool.query(
      `SELECT j.id, j.full_name, j.bio, j.detailed_bio, j.expertise,
              j.is_blacklisted, j.blacklist_reason, j.blacklist_date,
              (j.phone IS NOT NULL OR j.whatsapp IS NOT NULL OR j.email IS NOT NULL) AS has_contact,
              j.otp_sent_at,
              ${withContact ? 'j.phone, j.whatsapp, j.email,' : ''}
              COUNT(ja.id)::int AS assignment_count
       FROM judges j
       LEFT JOIN judge_assignments ja ON ja.judge_id = j.id
       GROUP BY j.id
       ORDER BY j.full_name`);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/judges/blacklist-report — blacklisted judges (rule #10) ───
router.get('/blacklist-report', requireRole(...manageRoles), async (req, res, next) => {
  try {
    const { rows: yc } = await pool.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
    const yearId = yc[0]?.id || null;
    const { rows } = await pool.query(
      `SELECT j.id, j.full_name, j.blacklist_reason, j.blacklist_date,
              COUNT(ja.id)::int AS assignments_this_year
       FROM judges j
       LEFT JOIN judge_assignments ja ON ja.judge_id = j.id
       LEFT JOIN events e ON e.id = ja.event_id AND ($1::int IS NULL OR e.year_id = $1)
       WHERE j.is_blacklisted = TRUE
       GROUP BY j.id
       ORDER BY j.blacklist_date DESC NULLS LAST, j.full_name`, [yearId]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/judges/:id/full — contact details (SuperAdmin/Chairman) ───
router.get('/:id/full', requireRole(...manageRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM judges WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Judge not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'VIEW_JUDGE_CONTACT', entity: 'judges', entityId: req.params.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/admin/judges/:id/assignments — events this judge is on ──────────
router.get('/:id/assignments', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ja.id AS assignment_id, ja.event_id, ja.time_slot_id, ja.assigned_at,
              e.event_code, e.event_name, c.name AS category_name
       FROM judge_assignments ja
       JOIN events e ON e.id = ja.event_id
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE ja.judge_id = $1
       ORDER BY e.event_code`, [req.params.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/admin/judges — create (SuperAdmin/Chairman) ────────────────────
router.post('/', requireRole(...manageRoles), async (req, res, next) => {
  try {
    const { full_name, bio, detailed_bio, expertise, phone, whatsapp, email } = req.body;
    if (!full_name?.trim()) return res.status(400).json({ error: 'full_name is required' });
    const { rows } = await pool.query(
      `INSERT INTO judges (full_name, bio, detailed_bio, expertise, phone, whatsapp, email)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [full_name.trim(), n(bio), n(detailed_bio), arr(expertise) || [], n(phone), n(whatsapp), n(email)]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'CREATE_JUDGE', entity: 'judges', entityId: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ── PUT /api/admin/judges/:id — update (SuperAdmin/Chairman) ─────────────────
router.put('/:id', requireRole(...manageRoles), async (req, res, next) => {
  try {
    const { full_name, bio, detailed_bio, expertise, phone, whatsapp, email } = req.body;
    const { rows } = await pool.query(
      `UPDATE judges SET
         full_name    = COALESCE($1, full_name),
         bio          = COALESCE($2, bio),
         detailed_bio = COALESCE($3, detailed_bio),
         expertise    = COALESCE($4, expertise),
         phone        = COALESCE($5, phone),
         whatsapp     = COALESCE($6, whatsapp),
         email        = COALESCE($7, email),
         updated_at   = NOW()
       WHERE id = $8 RETURNING *`,
      [n(full_name), n(bio), n(detailed_bio), arr(expertise), n(phone), n(whatsapp), n(email), req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Judge not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'UPDATE_JUDGE', entity: 'judges', entityId: req.params.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/judges/:id — refuse if assigned (blacklist instead) ────
router.delete('/:id', requireRole(...manageRoles), async (req, res, next) => {
  try {
    const { rows: asg } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM judge_assignments WHERE judge_id = $1`, [req.params.id]);
    if (asg[0].c > 0)
      return res.status(409).json({ error: `Judge has ${asg[0].c} assignment(s). Unassign them first, or blacklist the judge instead of deleting.` });
    const { rowCount } = await pool.query(`DELETE FROM judges WHERE id = $1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Judge not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'DELETE_JUDGE', entity: 'judges', entityId: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── POST /api/admin/judges/:id/blacklist (rule #10) ──────────────────────────
router.post('/:id/blacklist', requireRole(...manageRoles), async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: 'A blacklist reason is required' });
    const { rows } = await pool.query(
      `UPDATE judges SET is_blacklisted = TRUE, blacklist_reason = $1,
         blacklist_date = CURRENT_DATE, blacklisted_by = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [reason.trim(), req.user.id, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Judge not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'BLACKLIST_JUDGE', entity: 'judges', entityId: req.params.id, details: { reason } });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/admin/judges/:id/unblacklist ───────────────────────────────────
router.post('/:id/unblacklist', requireRole(...manageRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE judges SET is_blacklisted = FALSE, blacklist_reason = NULL,
         blacklist_date = NULL, blacklisted_by = NULL, updated_at = NOW()
       WHERE id = $1 RETURNING *`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Judge not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'UNBLACKLIST_JUDGE', entity: 'judges', entityId: req.params.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/admin/judges/:id/send-otp — manual, at briefing (rule #12) ─────
router.post('/:id/send-otp', requireRole(...assignRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT id, phone FROM judges WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Judge not found' });
    if (!rows[0].phone) return res.status(400).json({ error: 'Judge has no phone number on file' });

    const code = await createOtp(rows[0].phone);
    await sendWhatsApp(rows[0].phone, `Your KCA ITS judge login OTP is ${code}.`).catch(() => null);
    await pool.query(
      `UPDATE judges SET otp_sent_at = NOW(), otp_sent_by = $1 WHERE id = $2`,
      [req.user.id, req.params.id]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'SEND_JUDGE_OTP', entity: 'judges', entityId: req.params.id });
    res.json({ message: 'OTP sent to judge' });
  } catch (err) { next(err); }
});

// ── POST /api/admin/judges/assign — assign to an event (≈3/event) ────────────
// body: { judge_id, event_id, time_slot_id?, chairman_confirmed? }
router.post('/assign', requireRole(...assignRoles), async (req, res, next) => {
  try {
    const { judge_id, event_id, time_slot_id, chairman_confirmed } = req.body;
    if (!judge_id || !event_id)
      return res.status(400).json({ error: 'judge_id and event_id are required' });

    const { rows: jr } = await pool.query(`SELECT is_blacklisted FROM judges WHERE id = $1`, [judge_id]);
    if (!jr[0]) return res.status(404).json({ error: 'Judge not found' });

    // Blacklisted judges need Chairman/SuperAdmin confirmation (rule #10).
    if (jr[0].is_blacklisted && !chairman_confirmed)
      return res.status(409).json({ requiresChairmanConfirmation: true,
        warning: 'This judge is blacklisted. Assignment requires Chairman confirmation.' });
    if (jr[0].is_blacklisted && !canSeeContact(req.user.role))
      return res.status(403).json({ error: 'Only the Chairman or SuperAdmin can assign a blacklisted judge' });

    const { rows: existing } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM judge_assignments WHERE event_id = $1`, [event_id]);

    let inserted;
    try {
      const { rows } = await pool.query(
        `INSERT INTO judge_assignments (judge_id, event_id, time_slot_id, assigned_by)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [judge_id, event_id, n(time_slot_id), req.user.id]);
      inserted = rows[0];
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'This judge is already assigned to this event/slot' });
      throw e;
    }

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'ASSIGN_JUDGE', entity: 'judge_assignments', entityId: inserted.id,
      details: { judge_id, event_id, wasBlacklisted: jr[0].is_blacklisted } });
    res.status(201).json({
      assignment: inserted,
      event_judge_count: existing[0].c + 1,
      note: existing[0].c + 1 > 3 ? 'More than 3 judges now on this event.'
        : existing[0].c + 1 < 3 ? `${3 - (existing[0].c + 1)} more judge(s) needed (3 per event).` : '3 judges assigned — complete.',
    });
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/judges/assign/:assignmentId — unassign ─────────────────
router.delete('/assign/:assignmentId', requireRole(...assignRoles), async (req, res, next) => {
  try {
    const { rows: sc } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM scores WHERE judge_assignment_id = $1`, [req.params.assignmentId]);
    if (sc[0].c > 0)
      return res.status(409).json({ error: 'This judge has already entered scores for the event; cannot unassign.' });
    const { rowCount } = await pool.query(`DELETE FROM judge_assignments WHERE id = $1`, [req.params.assignmentId]);
    if (!rowCount) return res.status(404).json({ error: 'Assignment not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'UNASSIGN_JUDGE', entity: 'judge_assignments', entityId: req.params.assignmentId });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── GET /api/admin/judges/event/:eventId — judges assigned to an event ───────
router.get('/event/:eventId', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ja.id AS assignment_id, ja.time_slot_id, j.id AS judge_id,
              j.full_name, j.is_blacklisted
       FROM judge_assignments ja
       JOIN judges j ON j.id = ja.judge_id
       WHERE ja.event_id = $1
       ORDER BY j.full_name`, [req.params.eventId]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/judges/schedule-events — events from the schedule, by date ─
// Powers the assignment picker: one row per scheduled event, EARLIEST DATE
// FIRST, so judges are assigned against the (published) schedule. `published`
// is true when any of the event's schedule rows are confirmed.
router.get('/schedule-events', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows: yc } = await pool.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
    if (!yc[0]) return res.json([]);
    const { rows } = await pool.query(
      `SELECT e.id AS event_id, e.event_code, e.event_name, c.name AS category_name,
              to_char(MIN(s.event_date), 'YYYY-MM-DD') AS earliest_date,
              bool_or(s.status = 'confirmed') AS published,
              string_agg(DISTINCT to_char(s.event_date, 'YYYY-MM-DD'), ', '
                         ORDER BY to_char(s.event_date, 'YYYY-MM-DD')) AS dates
       FROM schedule s
       JOIN events e ON e.id = s.event_id
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE s.year_id = $1
       GROUP BY e.id, e.event_code, e.event_name, c.name
       ORDER BY MIN(s.event_date), e.event_code`, [yc[0].id]);
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;

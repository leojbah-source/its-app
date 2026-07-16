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

// Judging section is restricted to Chairman + SuperAdmin (separate access level).
const staffRoles = ['SuperAdmin', 'Chairman'];
const manageRoles = ['SuperAdmin', 'Chairman'];
const assignRoles = ['SuperAdmin', 'Chairman'];
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
    const r = await sendWhatsApp(rows[0].phone, `KCA ITS — your judge login OTP is ${code}.`);
    await pool.query(
      `UPDATE judges SET otp_sent_at = NOW(), otp_sent_by = $1 WHERE id = $2`,
      [req.user.id, req.params.id]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'SEND_JUDGE_OTP', entity: 'judges', entityId: req.params.id });
    const dev = process.env.OTP_DEV_ECHO === 'true' || process.env.NODE_ENV !== 'production';
    res.json({ message: r.delivered ? 'OTP sent to judge' : 'WhatsApp not configured — use the link to send', link: r.link, ...(dev ? { code } : {}) });
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

// ── GET /api/admin/judges/candidates/:eventId — judges for an event (strict) ─
// Only judges whose `expertise` includes the event's category code.
router.get('/candidates/:eventId', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows: ev } = await pool.query(
      `SELECT c.code AS category_code, c.name AS category_name
       FROM events e LEFT JOIN categories c ON c.id = e.category_id WHERE e.id = $1`,
      [req.params.eventId]);
    if (!ev[0]) return res.status(404).json({ error: 'Event not found' });
    const code = ev[0].category_code;
    const { rows } = await pool.query(
      `SELECT j.id, j.full_name, j.is_blacklisted, (j.phone IS NOT NULL) AS has_phone,
              EXISTS (SELECT 1 FROM judge_assignments ja
                      WHERE ja.judge_id = j.id AND ja.event_id = $2) AS assigned
       FROM judges j
       WHERE $1 = ANY (j.expertise)
       ORDER BY j.full_name`, [code, req.params.eventId]);
    res.json({ category_code: code, category_name: ev[0].category_name, candidates: rows });
  } catch (err) { next(err); }
});

// ── GET /api/admin/judges/event-assignments — scheduled events + their judges ─
// One row per event in the schedule, EARLIEST DATE FIRST, with the assigned
// judges. Drives the Event-Judges table on the Schedule page.
router.get('/event-assignments', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows: yc } = await pool.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
    if (!yc[0]) return res.json([]);
    const { rows: events } = await pool.query(
      `SELECT e.id AS event_id, e.event_code, e.event_name,
              c.code AS category_code, c.name AS category_name,
              to_char(MIN(s.event_date), 'YYYY-MM-DD') AS earliest_date,
              to_char(MIN(s.start_time), 'HH24:MI') AS first_start,
              COUNT(DISTINCT s.id)::int AS session_count,
              string_agg(DISTINCT NULLIF(s.venue, ''), ', ') AS venues,
              string_agg(DISTINCT NULLIF(s.age_groups, ''), ' | ') AS age_groups,
              bool_or(s.status = 'confirmed') AS published,
              (SELECT COUNT(*)::int FROM registrations r
               WHERE r.event_id = e.id AND r.status NOT IN ('withdrawn','swapped')) AS entries
       FROM schedule s
       JOIN events e ON e.id = s.event_id
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE s.year_id = $1
       GROUP BY e.id, e.event_code, e.event_name, c.code, c.name
       ORDER BY MIN(s.event_date), e.event_code`, [yc[0].id]);
    const ids = events.map((e) => e.event_id);
    const byEvent = {};
    if (ids.length) {
      const { rows: asg } = await pool.query(
        `SELECT ja.id AS assignment_id, ja.event_id, j.id AS judge_id, j.full_name,
                j.is_blacklisted, (j.phone IS NOT NULL) AS has_phone
         FROM judge_assignments ja JOIN judges j ON j.id = ja.judge_id
         WHERE ja.event_id = ANY($1) ORDER BY j.full_name`, [ids]);
      for (const a of asg) (byEvent[a.event_id] ??= []).push(a);
    }
    res.json(events.map((e) => ({ ...e, judges: byEvent[e.event_id] || [] })));
  } catch (err) { next(err); }
});

// ── POST /api/admin/judges/event/:eventId/send-otps — OTP all assigned judges ─
router.post('/event/:eventId/send-otps', requireRole(...assignRoles), async (req, res, next) => {
  try {
    const { rows: judges } = await pool.query(
      `SELECT j.id, j.full_name, j.phone FROM judge_assignments ja
       JOIN judges j ON j.id = ja.judge_id WHERE ja.event_id = $1`, [req.params.eventId]);
    if (!judges.length) return res.status(400).json({ error: 'No judges assigned to this event yet' });
    const dev = process.env.OTP_DEV_ECHO === 'true' || process.env.NODE_ENV !== 'production';
    let delivered = 0; const skipped = []; const links = []; const devCodes = [];
    for (const j of judges) {
      if (!j.phone) { skipped.push(j.full_name); continue; }
      const code = await createOtp(j.phone);
      const r = await sendWhatsApp(j.phone, `KCA ITS — your judge login OTP is ${code}. Log in with phone ${j.phone}.`);
      if (r.delivered) delivered += 1;
      links.push({ name: j.full_name, phone: j.phone, url: r.link, delivered: !!r.delivered });
      if (dev) devCodes.push({ name: j.full_name, code });
      await pool.query(`UPDATE judges SET otp_sent_at = NOW(), otp_sent_by = $1, active_event_id = $3 WHERE id = $2`, [req.user.id, j.id, req.params.eventId]);
    }
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'SEND_EVENT_OTPS', entity: 'events', entityId: req.params.eventId, details: { delivered, skipped } });
    res.json({ total: judges.length, delivered, skipped, links, ...(dev ? { dev_codes: devCodes } : {}) });
  } catch (err) { next(err); }
});

module.exports = router;

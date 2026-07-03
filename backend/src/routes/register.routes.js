// src/routes/register.routes.js  (mounted at /api/register, public-facing)
//
// DB-verified column names (do not assume):
//   participants: id, year_id, school_id, cpr_number, full_name, dob, gender,
//                 age_group_id, guardian_name, guardian_phone, photo_url,
//                 cpr_scan_url, membership_status, pwa_username, created_at, updated_at
//   users:        id, full_name, email, phone, password_hash, role, is_active,
//                 last_login_at, created_at, updated_at
//   registrations: id, year_id, participant_id, team_id, event_id, age_group_id,
//                  category_id, status (enum: registered|attended|absent|withdrawn|swapped),
//                  dance_teacher, music_teacher, registered_at, registered_by, updated_at
//   teams:         id, year_id, event_id, school_id, age_group_id, team_name, created_at
//   team_members:  id, team_id, participant_id, is_substitute, attendance_confirmed,
//                  confirmed_by, confirmed_at, created_at
//   age_groups:    id, year_id, code, label, dob_from, dob_to, sort_order
//   year_config:   id (PK), is_active (bool), max_individual_events, reg_deadline,
//                  team_reg_deadline, teacher_name_deadline

const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { verifyMembership } = require('../services/membership');
const { sendWhatsApp } = require('../utils/notify');
const { logAudit } = require('../utils/audit');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the active year_config row or null. Accepts an optional pg client. */
async function getActiveYear(clientOrPool) {
  const db = clientOrPool || pool;
  const { rows } = await db.query(
    `SELECT id, max_individual_events, reg_deadline, team_reg_deadline, teacher_name_deadline
     FROM year_config WHERE is_active = TRUE LIMIT 1`,
  );
  return rows[0] || null;
}

/** BHD uses 3 decimal places. */
const round3 = (x) => Math.round(Number(x) * 1000) / 1000;

/** Fee for one event: member rate when KCA membership is verified active. */
function eventFee(ev, memberActive) {
  const std = Number(ev.fee_amount || 0);
  if (!memberActive) return round3(std);
  return round3(ev.member_fee_amount != null ? Number(ev.member_fee_amount) : std);
}

/** Looks up the age_group_id for a given DOB (ISO string) within a year. */
async function resolveAgeGroup(dob, yearId) {
  const { rows } = await pool.query(
    `SELECT id FROM age_groups
     WHERE year_id = $1 AND dob_from <= $2::date AND dob_to >= $2::date
     LIMIT 1`,
    [yearId, dob],
  );
  return rows[0]?.id || null;
}

// ── GET /api/register/config ─────────────────────────────────────────────────
// Returns active year config for the registration portal (no auth).
router.get('/config', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, max_individual_events, reg_deadline, team_reg_deadline, teacher_name_deadline,
              benefit_pay_number, kca_iban
       FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    if (!rows[0]) return res.status(404).json({ error: 'No active year configured' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/register/schools ─────────────────────────────────────────────────
// Public list of schools (schools table has no year_id — it is a global lookup).
router.get('/schools', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name FROM schools WHERE is_active = TRUE ORDER BY name`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/register/age-groups ─────────────────────────────────────────────
// Public age group list for the active year.
router.get('/age-groups', async (req, res, next) => {
  try {
    const cfg = await getActiveYear();
    if (!cfg) return res.json([]);
    const { rows } = await pool.query(
      `SELECT id, code, label, dob_from, dob_to
       FROM age_groups WHERE year_id = $1 ORDER BY sort_order, code`,
      [cfg.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/register/events ─────────────────────────────────────────────────
// Public events list. Optional ?age_group_id= to filter to a participant's group.
router.get('/events', async (req, res, next) => {
  try {
    const cfg = await getActiveYear();
    if (!cfg) return res.json([]);
    const { age_group_id } = req.query;
    const args = [cfg.id];
    const ageFilter = age_group_id ? 'AND eag.age_group_id = $2' : '';
    if (age_group_id) args.push(age_group_id);

    const { rows } = await pool.query(
      `SELECT DISTINCT e.id, e.event_name, e.event_code, e.event_kind, e.fee_amount, e.member_fee_amount,
              c.name AS category_name
       FROM events e
       JOIN event_age_groups eag ON eag.event_id = e.id
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE e.year_id = $1 ${ageFilter} AND e.is_cancelled = FALSE
       ORDER BY e.event_code`,
      args,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/register/account ───────────────────────────────────────────────
// Creates a parent user account. Role is 'Viewer' until admin elevates it.
router.post('/account', async (req, res, next) => {
  try {
    const { email, password, full_name, phone } = req.body;
    if (!email || !password || !full_name)
      return res.status(400).json({ error: 'email, password and full_name are required' });

    const existing = await pool.query(
      `SELECT id FROM users WHERE email = $1`, [email.toLowerCase()],
    );
    if (existing.rows[0])
      return res.status(409).json({ error: 'An account with this email already exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Viewer', TRUE, NOW(), NOW())
       RETURNING id, email, full_name, role`,
      [full_name, email.toLowerCase(), phone || null, passwordHash],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/register/participant ───────────────────────────────────────────
// Registers a participant (child) under the active year. Requires auth token.
router.post('/participant', authenticate, async (req, res, next) => {
  try {
    const { cpr_number, full_name, dob, gender, school_id, guardian_name, guardian_phone } = req.body;
    if (!cpr_number || !full_name || !dob)
      return res.status(400).json({ error: 'cpr_number, full_name and dob are required' });

    const cfg = await getActiveYear();
    if (!cfg) return res.status(400).json({ error: 'No active year configuration' });

    const age_group_id = await resolveAgeGroup(dob, cfg.id);

    // If this CPR is already registered in the current year, return the existing record
    const { rows: existing } = await pool.query(
      `SELECT p.*, s.name AS school_name, ag.code AS age_group_code, ag.label AS age_group_label
       FROM participants p
       LEFT JOIN schools s ON s.id = p.school_id
       LEFT JOIN age_groups ag ON ag.id = p.age_group_id
       WHERE p.cpr_number = $1 AND p.year_id = $2`,
      [cpr_number, cfg.id],
    );
    if (existing[0]) return res.status(200).json({ ...existing[0], already_existed: true });

    const { rows } = await pool.query(
      `INSERT INTO participants
         (year_id, cpr_number, full_name, dob, gender, school_id, age_group_id,
          guardian_name, guardian_phone, pwa_username, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
       RETURNING *`,
      [cfg.id, cpr_number, full_name, dob, gender || null, school_id || null,
       age_group_id, guardian_name || null, guardian_phone || null,
       req.user.id.toString()],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/register/participant/lookup ─────────────────────────────────────
// Lookup by CPR in the active year. MUST be defined before /:id.
// Returns { found: true, participant: {...} } or { found: false }.
router.get('/participant/lookup', authenticate, async (req, res, next) => {
  try {
    const { cpr_number } = req.query;
    if (!cpr_number) return res.status(400).json({ error: 'cpr_number is required' });

    const cfg = await getActiveYear();
    if (!cfg) return res.status(400).json({ error: 'No active year' });

    const { rows } = await pool.query(
      `SELECT p.*, s.name AS school_name,
              ag.code AS age_group_code, ag.label AS age_group_label
       FROM participants p
       LEFT JOIN schools s ON s.id = p.school_id
       LEFT JOIN age_groups ag ON ag.id = p.age_group_id
       WHERE p.cpr_number = $1 AND p.year_id = $2 LIMIT 1`,
      [cpr_number.trim(), cfg.id],
    );
    if (!rows[0]) return res.json({ found: false });

    const { rows: regs } = await pool.query(
      `SELECT r.id, r.event_id, r.status, r.dance_teacher, r.music_teacher,
              e.event_name, e.event_code, e.event_kind, c.name AS category_name
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE r.participant_id = $1 ORDER BY r.registered_at`,
      [rows[0].id],
    );
    res.json({ found: true, participant: { ...rows[0], registrations: regs } });
  } catch (err) { next(err); }
});

// ── GET /api/register/my-participants ─────────────────────────────────────────
// Participants created by this user (via pwa_username) OR registered by them.
router.get('/my-participants', authenticate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT p.id, p.cpr_number, p.full_name, p.dob, p.gender,
              p.school_id, p.age_group_id, p.guardian_name, p.guardian_phone,
              p.membership_status, p.created_at,
              s.name AS school_name,
              ag.code AS age_group_code, ag.label AS age_group_label,
              (SELECT COUNT(*) FROM registrations r2
               WHERE r2.participant_id = p.id
                 AND r2.status NOT IN ('withdrawn', 'swapped')
              )::int AS active_event_count
       FROM participants p
       LEFT JOIN schools s ON s.id = p.school_id
       LEFT JOIN age_groups ag ON ag.id = p.age_group_id
       WHERE p.pwa_username = $1
          OR EXISTS (
            SELECT 1 FROM registrations r
            WHERE r.participant_id = p.id AND r.registered_by = $2
          )
       ORDER BY p.full_name`,
      [req.user.id.toString(), req.user.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/register/participant/:id ────────────────────────────────────────
// Returns participant profile + their active registrations.
router.get('/participant/:id', authenticate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, s.name AS school_name,
              ag.code AS age_group_code, ag.label AS age_group_label
       FROM participants p
       LEFT JOIN schools s ON s.id = p.school_id
       LEFT JOIN age_groups ag ON ag.id = p.age_group_id
       WHERE p.id = $1`,
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Participant not found' });

    const { rows: regs } = await pool.query(
      `SELECT r.id, r.event_id, r.status, r.dance_teacher, r.music_teacher,
              r.registered_at,
              e.event_name, e.event_code, e.event_kind,
              c.name AS category_name,
              ag.code AS age_group_code
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       LEFT JOIN categories c ON c.id = r.category_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       WHERE r.participant_id = $1
       ORDER BY r.registered_at`,
      [req.params.id],
    );

    res.json({ ...rows[0], registrations: regs });
  } catch (err) { next(err); }
});

// ── POST /api/register/participant/:id/scan ──────────────────────────────────
// Stores OCR-extracted CPR fields against a participant record.
router.post('/participant/:id/scan', authenticate, async (req, res, next) => {
  try {
    const { cpr_number, full_name, dob, cpr_scan_url } = req.body;
    if (!cpr_number) return res.status(400).json({ error: 'cpr_number (OCR result) is required' });

    const { rows } = await pool.query(
      `UPDATE participants SET
         cpr_number   = COALESCE($1, cpr_number),
         full_name    = COALESCE($2, full_name),
         dob          = COALESCE($3::date, dob),
         cpr_scan_url = COALESCE($4, cpr_scan_url),
         updated_at   = NOW()
       WHERE id = $5 RETURNING *`,
      [cpr_number, full_name || null, dob || null, cpr_scan_url || null, req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Participant not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/register/membership/verify ─────────────────────────────────────
// Verifies a KCA member number via mem.kcabah.com (§4.3). If participant_id is
// given, the result is stored on the participant and logged for the Admin:
//   active        → membership_status 'active' (member discount applies)
//   invalid       → 'none'
//   API unreachable → 'pending' (Admin verifies manually / via CSV fallback)
router.post('/membership/verify', async (req, res, next) => {
  try {
    const { member_no, member_id, participant_id, cpr_number } = req.body;
    const memberNo = member_no || member_id;
    if (!memberNo) return res.status(400).json({ error: 'member_no is required' });

    const result = await verifyMembership(memberNo, null);
    const status = result.active ? 'active'
      : result.error === 'API_UNAVAILABLE' ? 'pending'
      : 'none';

    if (participant_id) {
      await pool.query(
        `UPDATE participants SET membership_status = $1, updated_at = NOW() WHERE id = $2`,
        [status, participant_id],
      );
      await pool.query(
        `INSERT INTO membership_verifications (participant_id, cpr_number, member_status, raw_response)
         VALUES ($1, $2, $3, $4)`,
        [participant_id, cpr_number || memberNo, status, JSON.stringify(result)],
      );
    }
    res.json({ ...result, membership_status: status });
  } catch (err) { next(err); }
});

// ── POST /api/register/participant/:id/events ────────────────────────────────
// Bulk event selection for a participant. Validates eligibility and cap.
router.post('/participant/:id/events', authenticate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { event_ids } = req.body;
    if (!Array.isArray(event_ids) || event_ids.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'event_ids array is required' });
    }

    // Load participant + year config in one query
    const { rows: pRows } = await client.query(
      `SELECT p.*, yc.id AS year_config_id, yc.max_individual_events, yc.reg_deadline
       FROM participants p
       JOIN year_config yc ON yc.id = p.year_id
       WHERE p.id = $1`,
      [req.params.id],
    );
    const p = pRows[0];
    if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Participant not found' }); }

    // Deadline check
    if (p.reg_deadline && new Date() > new Date(p.reg_deadline)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Registration deadline has passed' });
    }

    // Current event count (exclude withdrawn)
    const { rows: cntRows } = await client.query(
      `SELECT COUNT(*) AS cnt FROM registrations
       WHERE participant_id = $1 AND status != 'withdrawn'`,
      [req.params.id],
    );
    const currentCount = parseInt(cntRows[0].cnt, 10);
    if (currentCount + event_ids.length > p.max_individual_events) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Cannot exceed ${p.max_individual_events} individual events. Currently registered: ${currentCount}`,
      });
    }

    // Member rate applies only on verified-active KCA membership (§4.3)
    const memberActive = p.membership_status === 'active';

    const created = [];
    let grossTotal = 0;
    let netTotal = 0;
    for (const eventId of event_ids) {
      // Validate event is eligible for this participant's age group and not cancelled
      const { rows: evRows } = await client.query(
        `SELECT e.id, e.category_id, e.event_kind, e.fee_amount, e.member_fee_amount
         FROM events e
         JOIN event_age_groups eag ON eag.event_id = e.id
         WHERE e.id = $1
           AND eag.age_group_id = $2
           AND e.is_cancelled = FALSE
           AND e.year_id = $3`,
        [eventId, p.age_group_id, p.year_id],
      );
      if (!evRows[0]) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Event ${eventId} is not available for this participant's age group`,
        });
      }

      // Skip if already registered (idempotent)
      const { rows: existing } = await client.query(
        `SELECT id FROM registrations
         WHERE participant_id = $1 AND event_id = $2 AND status != 'withdrawn'`,
        [req.params.id, eventId],
      );
      if (existing[0]) continue;

      const netFee = eventFee(evRows[0], memberActive);
      grossTotal = round3(grossTotal + Number(evRows[0].fee_amount || 0));
      netTotal = round3(netTotal + netFee);

      const { rows } = await client.query(
        `INSERT INTO registrations
           (year_id, participant_id, event_id, age_group_id, category_id,
            fee_amount, status, registered_by, registered_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'registered',$7,NOW(),NOW())
         RETURNING *`,
        [p.year_id, req.params.id, eventId, p.age_group_id,
         evRows[0].category_id, netFee, req.user.id],
      );
      created.push(rows[0]);
    }

    await client.query('COMMIT');
    res.status(201).json({
      created,
      fees: {
        gross: grossTotal,
        member_rate_applied: memberActive,
        discount: round3(grossTotal - netTotal),
        total_due: netTotal,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── PUT /api/register/participant/:id/events ─────────────────────────────────
// Add or withdraw individual events after initial registration.
router.put('/participant/:id/events', authenticate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { add_event_ids = [], remove_event_ids = [], removal_reason } = req.body;

    // Removals require a mandatory reason (§5.3)
    if (remove_event_ids.length > 0 && !removal_reason?.trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'removal_reason is required when removing events' });
    }

    const { rows: pRows } = await client.query(
      `SELECT p.*, yc.max_individual_events, yc.reg_deadline
       FROM participants p
       JOIN year_config yc ON yc.id = p.year_id
       WHERE p.id = $1`,
      [req.params.id],
    );
    const p = pRows[0];
    if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Participant not found' }); }

    if (p.reg_deadline && new Date() > new Date(p.reg_deadline)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Registration deadline has passed' });
    }

    const memberActive = p.membership_status === 'active';
    const added = [];
    let additionalDue = 0;

    // Add events
    if (add_event_ids.length > 0) {
      const { rows: cntRows } = await client.query(
        `SELECT COUNT(*) AS cnt FROM registrations
         WHERE participant_id = $1 AND status != 'withdrawn'`,
        [req.params.id],
      );
      const currentCount = parseInt(cntRows[0].cnt, 10);
      if (currentCount + add_event_ids.length > p.max_individual_events) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Cannot exceed ${p.max_individual_events} individual events` });
      }

      for (const eventId of add_event_ids) {
        const { rows: evRows } = await client.query(
          `SELECT e.id, e.category_id, e.fee_amount, e.member_fee_amount FROM events e
           JOIN event_age_groups eag ON eag.event_id = e.id
           WHERE e.id = $1 AND eag.age_group_id = $2 AND e.is_cancelled = FALSE`,
          [eventId, p.age_group_id],
        );
        if (!evRows[0]) continue; // silently skip ineligible — caller should validate first

        const { rows: existing } = await client.query(
          `SELECT id FROM registrations
           WHERE participant_id = $1 AND event_id = $2 AND status != 'withdrawn'`,
          [req.params.id, eventId],
        );
        if (existing[0]) continue;

        const netFee = eventFee(evRows[0], memberActive);
        additionalDue = round3(additionalDue + netFee);

        const { rows } = await client.query(
          `INSERT INTO registrations
             (year_id, participant_id, event_id, age_group_id, category_id,
              fee_amount, status, registered_by, registered_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,'registered',$7,NOW(),NOW())
           RETURNING *`,
          [p.year_id, req.params.id, eventId, p.age_group_id,
           evRows[0].category_id, netFee, req.user.id],
        );
        added.push(rows[0]);
      }
    }

    // Withdraw events — each withdrawal creates a pending refund request that
    // the Admin confirms (amount/method) for the Refunds Report (§4.10, §5.3).
    const withdrawn = [];
    let refundDue = 0;
    for (const eventId of remove_event_ids) {
      const { rows } = await client.query(
        `UPDATE registrations r SET status = 'withdrawn', updated_at = NOW()
         FROM events e
         WHERE r.participant_id = $1 AND r.event_id = $2 AND r.status = 'registered'
           AND e.id = r.event_id
         RETURNING r.*, e.event_code, e.event_name`,
        [req.params.id, eventId],
      );
      for (const reg of rows) {
        refundDue = round3(refundDue + Number(reg.fee_amount || 0));
        await client.query(
          `INSERT INTO refunds
             (year_id, participant_id, registration_id, events_withdrawn, reason,
              original_amount, refund_amount, status, requested_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
          [p.year_id, req.params.id, reg.id,
           `${reg.event_code} — ${reg.event_name}`, removal_reason.trim(),
           reg.fee_amount || 0, reg.fee_amount || 0, req.user.id],
        );
      }
      withdrawn.push(...rows);
    }

    await client.query('COMMIT');

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'UPDATE_REGISTRATIONS', entity: 'participants', entityId: req.params.id,
      details: { added: added.map(r => r.event_id), withdrawn: withdrawn.map(r => r.event_id),
                 removal_reason: removal_reason || null, additional_due: additionalDue, refund_due: refundDue } });

    res.json({ added, withdrawn, fees: { additional_due: additionalDue, refund_due: refundDue } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── PUT /api/register/participant/:id/teacher ─────────────────────────────────
// Updates dance_teacher or music_teacher on a registration (until deadline).
// teacher_type: 'dance' | 'music'
// teacher_name: free text, or 'NOT_APPLICABLE' (excluded from teacher awards)
router.put('/participant/:id/teacher', authenticate, async (req, res, next) => {
  try {
    const { event_id, teacher_type, teacher_name } = req.body;
    if (!event_id || !teacher_type || !teacher_name)
      return res.status(400).json({ error: 'event_id, teacher_type and teacher_name are required' });
    if (!['dance', 'music'].includes(teacher_type))
      return res.status(400).json({ error: "teacher_type must be 'dance' or 'music'" });

    // Check teacher name deadline from active year config
    const { rows: cfgRows } = await pool.query(
      `SELECT teacher_name_deadline FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    const deadline = cfgRows[0]?.teacher_name_deadline;
    if (deadline && new Date() > new Date(deadline))
      return res.status(403).json({ error: 'Teacher name submission deadline has passed' });

    const column = teacher_type === 'dance' ? 'dance_teacher' : 'music_teacher';
    const { rows } = await pool.query(
      `UPDATE registrations
       SET ${column} = $1, updated_at = NOW()
       WHERE participant_id = $2 AND event_id = $3 AND status != 'withdrawn'
       RETURNING *`,
      [teacher_name, req.params.id, event_id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Registration not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/register/participant/:id/fees ───────────────────────────────────
// Live fee summary (§5.2): per-event fees, discount, payments, balance due.
router.get('/participant/:id/fees', authenticate, async (req, res, next) => {
  try {
    const { rows: items } = await pool.query(
      `SELECT r.id AS registration_id, r.event_id, r.fee_amount, r.status,
              e.event_code, e.event_name
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       WHERE r.participant_id = $1 AND r.status NOT IN ('withdrawn','swapped')
       ORDER BY e.event_code`,
      [req.params.id],
    );
    const { rows: pays } = await pool.query(
      `SELECT id, amount, method, status, reference, created_at, confirmed_at
       FROM payments WHERE participant_id = $1 ORDER BY created_at`,
      [req.params.id],
    );
    const { rows: refs } = await pool.query(
      `SELECT id, refund_amount, status, reason, created_at
       FROM refunds WHERE participant_id = $1 ORDER BY created_at`,
      [req.params.id],
    );

    const feesTotal = round3(items.reduce((s, r) => s + Number(r.fee_amount || 0), 0));
    const paidConfirmed = round3(pays.filter(x => x.status === 'confirmed')
      .reduce((s, x) => s + Number(x.amount), 0));
    const paidPending = round3(pays.filter(x => x.status === 'pending')
      .reduce((s, x) => s + Number(x.amount), 0));

    res.json({
      items,
      payments: pays,
      refunds: refs,
      summary: {
        fees_total: feesTotal,
        paid_confirmed: paidConfirmed,
        paid_pending: paidPending,
        balance_due: round3(feesTotal - paidConfirmed),
      },
    });
  } catch (err) { next(err); }
});

// ── POST /api/register/participant/:id/payment ───────────────────────────────
// Parent submits a payment (§5.4): cash (provisional, confirmed at KCA office),
// benefitpay or bank_transfer (with proof screenshot + reference).
router.post('/participant/:id/payment', authenticate, async (req, res, next) => {
  try {
    const { amount, method, reference, proof_url, notes } = req.body;
    if (!amount || Number(amount) <= 0)
      return res.status(400).json({ error: 'A positive amount is required' });
    if (!['cash', 'benefitpay', 'bank_transfer'].includes(method))
      return res.status(400).json({ error: "method must be 'cash', 'benefitpay' or 'bank_transfer'" });
    if (method !== 'cash' && !proof_url)
      return res.status(400).json({ error: 'proof_url (payment screenshot) is required for BenefitPay / bank transfer' });

    const { rows: pRows } = await pool.query(
      `SELECT id, year_id, full_name, guardian_phone FROM participants WHERE id = $1`,
      [req.params.id],
    );
    const p = pRows[0];
    if (!p) return res.status(404).json({ error: 'Participant not found' });

    const { rows } = await pool.query(
      `INSERT INTO payments
         (year_id, parent_user_id, participant_id, amount, method, status,
          reference, proof_url, notes)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8)
       RETURNING *`,
      [p.year_id, req.user.id, p.id, amount, method,
       reference || null, proof_url || null, notes || null],
    );

    // Confirmation WhatsApp on submission (§5.4) — fire and forget
    if (p.guardian_phone) {
      sendWhatsApp(p.guardian_phone,
        `KCA ITS: Your payment of BHD ${Number(amount).toFixed(3)} for ${p.full_name} ` +
        `(${method.replace('_', ' ')}) has been received and is pending confirmation.`,
      ).catch(() => null);
    }

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'SUBMIT_PAYMENT', entity: 'payments', entityId: rows[0].id,
      details: { participant_id: p.id, amount, method } });

    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/register/team ───────────────────────────────────────────────────
// Creates a team registration with initial member list.
router.post('/team', authenticate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { event_id, team_name, school_id, age_group_id, participant_ids = [] } = req.body;
    if (!event_id || !team_name || participant_ids.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'event_id, team_name and participant_ids are required' });
    }

    const cfg = await getActiveYear(client);
    if (!cfg) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No active year' }); }

    // Team deadline check
    if (cfg.team_reg_deadline && new Date() > new Date(cfg.team_reg_deadline)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Team registration deadline has passed' });
    }

    // Validate the event exists and is a team event
    const { rows: evRows } = await client.query(
      `SELECT id, category_id, event_kind FROM events
       WHERE id = $1 AND event_kind = 'team' AND is_cancelled = FALSE`,
      [event_id],
    );
    if (!evRows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Event not found or is not a team event' });
    }
    const category_id = evRows[0].category_id;

    const { rows: teamRows } = await client.query(
      `INSERT INTO teams (year_id, event_id, team_name, school_id, age_group_id, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *`,
      [cfg.id, event_id, team_name, school_id || null, age_group_id || null],
    );
    const team = teamRows[0];

    for (const participantId of participant_ids) {
      // Get participant's age_group_id for the registration row
      const { rows: pRows } = await client.query(
        `SELECT age_group_id FROM participants WHERE id = $1`,
        [participantId],
      );
      const memberAgeGroupId = pRows[0]?.age_group_id || age_group_id;

      await client.query(
        `INSERT INTO team_members (team_id, participant_id) VALUES ($1,$2)`,
        [team.id, participantId],
      );
      await client.query(
        `INSERT INTO registrations
           (year_id, participant_id, team_id, event_id, age_group_id, category_id,
            status, registered_by, registered_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'registered',$7,NOW(),NOW())`,
        [cfg.id, participantId, team.id, event_id, memberAgeGroupId, category_id, req.user.id],
      );
    }

    await client.query('COMMIT');

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'CREATE_TEAM', entity: 'teams', entityId: team.id });
    res.status(201).json(team);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── POST /api/register/participant/:id/swap ───────────────────────────────────
// One-time swap: participant whose registration was withdrawn due to event
// cancellation can swap into another eligible event.
// Marks old registration 'swapped', creates a new 'registered' entry.
router.post('/participant/:id/swap', authenticate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { old_registration_id, new_event_id } = req.body;
    if (!old_registration_id || !new_event_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'old_registration_id and new_event_id are required' });
    }

    // Load original registration
    const { rows: regRows } = await client.query(
      `SELECT r.*, p.age_group_id, p.year_id AS p_year_id, e.is_cancelled
       FROM registrations r
       JOIN participants p ON p.id = r.participant_id
       JOIN events e ON e.id = r.event_id
       WHERE r.id = $1 AND r.participant_id = $2`,
      [old_registration_id, req.params.id],
    );
    const reg = regRows[0];
    if (!reg) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Registration not found' }); }

    if (reg.status !== 'withdrawn') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Swap is only available for withdrawn registrations' });
    }
    if (!reg.is_cancelled) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Swap is only available when the original event was cancelled' });
    }

    // Validate new event eligibility
    const { rows: evRows } = await client.query(
      `SELECT e.id, e.category_id FROM events e
       JOIN event_age_groups eag ON eag.event_id = e.id
       WHERE e.id = $1
         AND eag.age_group_id = $2
         AND e.is_cancelled = FALSE`,
      [new_event_id, reg.age_group_id],
    );
    if (!evRows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'New event is not available for this participant' });
    }

    // Mark old as swapped
    await client.query(
      `UPDATE registrations SET status = 'swapped', updated_at = NOW() WHERE id = $1`,
      [old_registration_id],
    );

    // Create new registration
    const { rows: newReg } = await client.query(
      `INSERT INTO registrations
         (year_id, participant_id, event_id, age_group_id, category_id,
          status, registered_by, registered_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'registered',$6,NOW(),NOW())
       RETURNING *`,
      [reg.year_id, req.params.id, new_event_id, reg.age_group_id,
       evRows[0].category_id, req.user.id],
    );

    await client.query('COMMIT');

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'SWAP_REGISTRATION', entity: 'registrations',
      entityId: old_registration_id,
      details: { new_registration_id: newReg[0].id, new_event_id } });
    res.json(newReg[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

module.exports = router;

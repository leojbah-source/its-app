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

    const { rows } = await pool.query(
      `INSERT INTO participants
         (year_id, cpr_number, full_name, dob, gender, school_id, age_group_id,
          guardian_name, guardian_phone, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
       RETURNING *`,
      [cfg.id, cpr_number, full_name, dob, gender || null, school_id || null,
       age_group_id, guardian_name || null, guardian_phone || null],
    );
    res.status(201).json(rows[0]);
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
router.post('/membership/verify', async (req, res, next) => {
  try {
    const { cpr_number, member_id } = req.body;
    const result = await verifyMembership({ cprNumber: cpr_number, memberId: member_id });
    res.json(result);
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

    const created = [];
    for (const eventId of event_ids) {
      // Validate event is eligible for this participant's age group and not cancelled
      const { rows: evRows } = await client.query(
        `SELECT e.id, e.category_id, e.event_kind
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

      const { rows } = await client.query(
        `INSERT INTO registrations
           (year_id, participant_id, event_id, age_group_id, category_id,
            status, registered_by, registered_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'registered',$6,NOW(),NOW())
         RETURNING *`,
        [p.year_id, req.params.id, eventId, p.age_group_id,
         evRows[0].category_id, req.user.id],
      );
      created.push(rows[0]);
    }

    await client.query('COMMIT');
    res.status(201).json(created);
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
    const { add_event_ids = [], remove_event_ids = [] } = req.body;

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

    const added = [];

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
          `SELECT e.id, e.category_id FROM events e
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

        const { rows } = await client.query(
          `INSERT INTO registrations
             (year_id, participant_id, event_id, age_group_id, category_id,
              status, registered_by, registered_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,'registered',$6,NOW(),NOW())
           RETURNING *`,
          [p.year_id, req.params.id, eventId, p.age_group_id,
           evRows[0].category_id, req.user.id],
        );
        added.push(rows[0]);
      }
    }

    // Withdraw events
    const withdrawn = [];
    for (const eventId of remove_event_ids) {
      const { rows } = await client.query(
        `UPDATE registrations SET status = 'withdrawn', updated_at = NOW()
         WHERE participant_id = $1 AND event_id = $2 AND status = 'registered'
         RETURNING *`,
        [req.params.id, eventId],
      );
      withdrawn.push(...rows);
    }

    await client.query('COMMIT');
    res.json({ added, withdrawn });
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

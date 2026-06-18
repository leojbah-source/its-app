// src/routes/register.routes.js  (mounted at /api/register, public-facing)
const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { verifyMembership } = require('../services/membership');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// POST /api/register/account  -- parent account creation
router.post('/account', async (req, res, next) => {
  try {
    const { email, password, name, phone } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password and name are required' });

    const existing = await pool.query(`SELECT id FROM users WHERE email = $1`, [email.toLowerCase()]);
    if (existing.rows[0]) return res.status(409).json({ error: 'An account with this email already exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, role, created_at)
       VALUES ($1,$2,$3,'Viewer', NOW()) RETURNING id, email, name, role`,
      [email.toLowerCase(), passwordHash, name]
    );
    if (phone) await pool.query(`UPDATE users SET phone = $1 WHERE id = $2`, [phone, rows[0].id]).catch(() => null);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/register/child  -- add a child/participant under a parent account
router.post('/child', async (req, res, next) => {
  try {
    const { parent_user_id, name, dob, cpr_number, school, gender } = req.body;
    if (!parent_user_id || !name || !dob || !cpr_number) {
      return res.status(400).json({ error: 'parent_user_id, name, dob and cpr_number are required' });
    }

    // age_group is DOB-derived per year_config (rule #1: nothing hard-coded per year)
    const { rows: ageRows } = await pool.query(
      `SELECT age_group_config FROM year_config WHERE status = 'published' ORDER BY year_id DESC LIMIT 1`
    );
    const ageGroupConfig = ageRows[0]?.age_group_config || [];
    const age = Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 24 * 3600 * 1000));
    const matched = ageGroupConfig.find((g) => age >= g.min_age && age <= g.max_age);

    const { rows } = await pool.query(
      `INSERT INTO children (parent_user_id, name, dob, cpr_number, age_group, school, gender, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, NOW()) RETURNING *`,
      [parent_user_id, name, dob, cpr_number, matched?.label || null, school || null, gender || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/register/child/:id/scan  -- CPR scan (Tesseract.js / Google Vision)
// The actual OCR call happens client-side or via a dedicated worker; this endpoint
// just stores the extracted fields and links the source image.
router.post('/child/:id/scan', async (req, res, next) => {
  try {
    const { cpr_number, name, dob, photo_url } = req.body;
    if (!cpr_number) return res.status(400).json({ error: 'cpr_number (OCR result) is required' });

    const { rows } = await pool.query(
      `UPDATE children SET
         cpr_number = COALESCE($1, cpr_number), name = COALESCE($2, name),
         dob = COALESCE($3, dob), photo_url = COALESCE($4, photo_url)
       WHERE id = $5 RETURNING *`,
      [cpr_number, name, dob || null, photo_url || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Child not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/register/membership/verify -> membership.js
router.post('/membership/verify', async (req, res, next) => {
  try {
    const { cpr_number, member_id } = req.body;
    const result = await verifyMembership({ cprNumber: cpr_number, memberId: member_id });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/register/child/:id/events  -- initial event selection for a child
router.post('/child/:id/events', async (req, res, next) => {
  try {
    const { year_id, event_ids } = req.body;
    if (!year_id || !Array.isArray(event_ids) || event_ids.length === 0) {
      return res.status(400).json({ error: 'year_id and a non-empty event_ids array are required' });
    }
    const created = [];
    for (const eventId of event_ids) {
      const { rows } = await pool.query(
        `INSERT INTO registrations (year_id, child_id, event_id, status, created_at)
         VALUES ($1,$2,$3,'pending_payment', NOW()) RETURNING *`,
        [year_id, req.params.id, eventId]
      );
      created.push(rows[0]);
    }
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// PUT /api/register/child/:id/events  -- additions => extra fee, removals => refund_log
router.put('/child/:id/events', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { add_event_ids = [], remove_event_ids = [], year_id } = req.body;
    await client.query('BEGIN');

    const added = [];
    for (const eventId of add_event_ids) {
      const { rows: evRows } = await client.query(`SELECT id FROM events WHERE id = $1`, [eventId]);
      if (!evRows[0]) continue;
      const { rows } = await client.query(
        `INSERT INTO registrations (year_id, child_id, event_id, status, created_at)
         VALUES ($1,$2,$3,'pending_payment', NOW()) RETURNING *`,
        [year_id, req.params.id, eventId]
      );
      added.push(rows[0]);
    }

    const removed = [];
    for (const eventId of remove_event_ids) {
      const { rows: regRows } = await client.query(
        `UPDATE registrations SET status = 'cancelled_by_parent'
         WHERE child_id = $1 AND event_id = $2 AND status != 'cancelled_by_parent'
         RETURNING *`,
        [req.params.id, eventId]
      );
      for (const reg of regRows) {
        const { rows: refundRows } = await client.query(
          `INSERT INTO refund_log (registration_id, amount, reason, status, created_at)
           VALUES ($1, $2, 'event_removed_by_parent', 'pending', NOW()) RETURNING *`,
          [reg.id, reg.fee || 0]
        );
        removed.push(refundRows[0]);
      }
    }

    await client.query('COMMIT');
    res.json({ added, removedRefunds: removed });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally {
    client.release();
  }
});

// PUT /api/register/child/:id/teacher  -- update teacher name (before deadline) - rules #17, #18
router.put('/child/:id/teacher', async (req, res, next) => {
  try {
    const { event_id, teacher_name, year_id } = req.body;
    if (!event_id || !teacher_name || !year_id) {
      return res.status(400).json({ error: 'event_id, teacher_name and year_id are required' });
    }

    const { rows: cfgRows } = await pool.query(`SELECT teacher_name_deadline FROM year_config WHERE year_id = $1`, [year_id]);
    const deadline = cfgRows[0]?.teacher_name_deadline;
    if (deadline && new Date() > new Date(deadline)) {
      return res.status(403).json({ error: 'Teacher name deadline has passed for this year' });
    }

    // 'NOT_APPLICABLE' for self-taught - excluded from teacher awards (rule #17)
    const { rows } = await pool.query(
      `UPDATE registrations SET teacher_name = $1
       WHERE child_id = $2 AND event_id = $3 RETURNING *`,
      [teacher_name, req.params.id, event_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Registration not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/register/team
router.post('/team', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { year_id, event_id, team_name, school, child_ids = [] } = req.body;
    if (!year_id || !event_id || !team_name || child_ids.length === 0) {
      return res.status(400).json({ error: 'year_id, event_id, team_name and child_ids are required' });
    }
    await client.query('BEGIN');
    const { rows: teamRows } = await client.query(
      `INSERT INTO teams (year_id, event_id, team_name, school, created_at) VALUES ($1,$2,$3,$4, NOW()) RETURNING *`,
      [year_id, event_id, team_name, school || null]
    );
    const team = teamRows[0];

    for (const childId of child_ids) {
      await client.query(`INSERT INTO team_members (team_id, child_id, confirmed) VALUES ($1,$2,false)`, [team.id, childId]);
      await client.query(
        `INSERT INTO registrations (year_id, child_id, team_id, event_id, status, created_at)
         VALUES ($1,$2,$3,$4,'pending_payment', NOW())`,
        [year_id, childId, team.id, event_id]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(team);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/register/payment
router.post('/payment', async (req, res, next) => {
  try {
    const { registration_id, amount, method, transaction_ref } = req.body;
    if (!registration_id || !amount || !method) {
      return res.status(400).json({ error: 'registration_id, amount and method are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO payments (registration_id, amount, method, status, transaction_ref, created_at)
       VALUES ($1,$2,$3,'pending',$4, NOW()) RETURNING *`,
      [registration_id, amount, method, transaction_ref || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/register/cancelled-event-swap/:reg_id  -- one-time swap after initial list published (rule #20)
router.post('/cancelled-event-swap/:reg_id', async (req, res, next) => {
  try {
    const { new_event_id } = req.body;
    if (!new_event_id) return res.status(400).json({ error: 'new_event_id is required' });

    const { rows: regRows } = await pool.query(`SELECT * FROM registrations WHERE id = $1`, [req.params.reg_id]);
    const reg = regRows[0];
    if (!reg) return res.status(404).json({ error: 'Registration not found' });
    if (reg.status !== 'cancelled_event') {
      return res.status(400).json({ error: 'Swap is only available for registrations affected by an event cancellation' });
    }
    if (reg.swap_used) return res.status(403).json({ error: 'Swap window already used for this registration' });

    const { rows } = await pool.query(
      `UPDATE registrations SET event_id = $1, status = 'confirmed', swap_used = true
       WHERE id = $2 RETURNING *`,
      [new_event_id, req.params.reg_id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

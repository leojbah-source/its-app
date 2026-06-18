// src/routes/admin.judges.routes.js  (mounted at /api/admin/judges)
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { createOtp } = require('../utils/otp');
const { sendWhatsApp } = require('../utils/notify');

const router = express.Router();
router.use(authenticate);
const staffRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'];
const editRoles = ['SuperAdmin', 'Admin', 'Chairman'];

// GET /api/admin/judges  -- name, bio, assignments only (rule #11: contact for SuperAdmin/Chairman only)
router.get('/', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT j.id, j.name, j.bio, j.is_blacklisted,
              COALESCE(json_agg(json_build_object('event_id', ja.event_id, 'status', ja.status))
                       FILTER (WHERE ja.id IS NOT NULL), '[]') AS assignments
       FROM judges j
       LEFT JOIN judge_assignments ja ON ja.judge_id = j.id
       GROUP BY j.id ORDER BY j.name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/judges/:id/full  -- SuperAdmin + Chairman ONLY: includes phone/whatsapp/email (rule #11)
router.get('/:id/full', requireRole('SuperAdmin', 'Chairman'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM judges WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Judge not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'VIEW_JUDGE_CONTACT', entity: 'judges', entityId: req.params.id });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// CRUD /api/admin/judges  -- SuperAdmin + Chairman manage profiles
router.post('/', requireRole('SuperAdmin', 'Chairman'), async (req, res, next) => {
  try {
    const { name, bio, phone, whatsapp, email } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO judges (name, bio, phone, whatsapp, email, is_blacklisted, created_at)
       VALUES ($1,$2,$3,$4,$5,false, NOW()) RETURNING *`,
      [name, bio || null, phone || null, whatsapp || null, email || null]
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CREATE_JUDGE', entity: 'judges', entityId: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireRole('SuperAdmin', 'Chairman'), async (req, res, next) => {
  try {
    const { name, bio, phone, whatsapp, email } = req.body;
    const { rows } = await pool.query(
      `UPDATE judges SET
         name = COALESCE($1, name), bio = COALESCE($2, bio), phone = COALESCE($3, phone),
         whatsapp = COALESCE($4, whatsapp), email = COALESCE($5, email)
       WHERE id = $6 RETURNING *`,
      [name, bio, phone, whatsapp, email, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Judge not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'UPDATE_JUDGE', entity: 'judges', entityId: req.params.id });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireRole('SuperAdmin', 'Chairman'), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM judges WHERE id = $1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Judge not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'DELETE_JUDGE', entity: 'judges', entityId: req.params.id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/judges/:id/blacklist  -- SuperAdmin + Chairman: set is_blacklisted, reason, date (rule #10)
router.post('/:id/blacklist', requireRole('SuperAdmin', 'Chairman'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'reason is required' });
    const { rows } = await pool.query(
      `UPDATE judges SET is_blacklisted = true, blacklist_reason = $1, blacklist_date = NOW()
       WHERE id = $2 RETURNING *`,
      [reason, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Judge not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'BLACKLIST_JUDGE', entity: 'judges', entityId: req.params.id, details: { reason } });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/judges/:id/unblacklist
router.post('/:id/unblacklist', requireRole('SuperAdmin', 'Chairman'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE judges SET is_blacklisted = false, blacklist_reason = NULL, blacklist_date = NULL
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Judge not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'UNBLACKLIST_JUDGE', entity: 'judges', entityId: req.params.id });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/judges/blacklist-report/:year_id  -- SuperAdmin + Chairman only
router.get('/blacklist-report/:year_id', requireRole('SuperAdmin', 'Chairman'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT j.id, j.name, j.blacklist_reason, j.blacklist_date,
              COUNT(ja.id) AS assignments_this_year
       FROM judges j
       LEFT JOIN judge_assignments ja ON ja.judge_id = j.id AND ja.year_id = $1
       WHERE j.is_blacklisted = true
       GROUP BY j.id ORDER BY j.blacklist_date DESC`,
      [req.params.year_id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/judges/:id/send-otp  -- Convener initiates manually, NOT auto on assignment (rule #12)
router.post('/:id/send-otp', requireRole('SuperAdmin', 'Admin', 'Coordinator', 'Chairman'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT id, phone FROM judges WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Judge not found' });
    if (!rows[0].phone) return res.status(400).json({ error: 'Judge has no phone number on file' });

    const code = await createOtp(rows[0].phone);
    await sendWhatsApp(rows[0].phone, `Your KCA ITS judge login OTP is ${code}.`);
    await pool.query(
      `UPDATE judge_assignments SET otp_sent_at = NOW() WHERE judge_id = $1 AND otp_sent_at IS NULL`,
      [req.params.id]
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'SEND_JUDGE_OTP', entity: 'judges', entityId: req.params.id });
    res.json({ message: 'OTP sent to judge' });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/judges/assign  -- warn if blacklisted; require Chairman confirmation
router.post('/assign', requireRole('SuperAdmin', 'Admin', 'Coordinator', 'Chairman'), async (req, res, next) => {
  try {
    const { year_id, event_id, judge_id, chairman_confirmed } = req.body;
    if (!year_id || !event_id || !judge_id) {
      return res.status(400).json({ error: 'year_id, event_id and judge_id are required' });
    }

    const { rows: judgeRows } = await pool.query(`SELECT is_blacklisted FROM judges WHERE id = $1`, [judge_id]);
    if (!judgeRows[0]) return res.status(404).json({ error: 'Judge not found' });

    if (judgeRows[0].is_blacklisted && !chairman_confirmed) {
      return res.status(409).json({
        warning: 'This judge is blacklisted. Assignment requires Chairman confirmation.',
        requiresChairmanConfirmation: true,
      });
    }
    if (judgeRows[0].is_blacklisted && chairman_confirmed && req.user.role !== 'Chairman' && req.user.role !== 'SuperAdmin') {
      return res.status(403).json({ error: 'Only the Chairman (or SuperAdmin) can confirm assignment of a blacklisted judge' });
    }

    const { rows } = await pool.query(
      `INSERT INTO judge_assignments (year_id, event_id, judge_id, status, created_at)
       VALUES ($1,$2,$3,'assigned', NOW()) RETURNING *`,
      [year_id, event_id, judge_id]
    );
    await logAudit({
      actorId: req.user.id, actorRole: req.user.role, action: 'ASSIGN_JUDGE', entity: 'judge_assignments',
      entityId: rows[0].id, details: { wasBlacklisted: judgeRows[0].is_blacklisted },
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

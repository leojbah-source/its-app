// src/routes/admin.config.routes.js  (mounted at /api/admin)
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { generateDraftSchedule } = require('../services/scheduler');

const router = express.Router();
router.use(authenticate);

// GET /api/admin/config/:year_id  -- rule #1: all annual params live in year_config
router.get('/config/:year_id', requireRole('SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM year_config WHERE year_id = $1`, [req.params.year_id]);
    if (!rows[0]) return res.status(404).json({ error: 'Year config not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/config/:year_id
router.put('/config/:year_id', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const {
      year_label, age_group_config, grade_config, rank_points_config,
      participation_bonus_pts, divergence_threshold_pct, teacher_name_deadline,
      kca_logo_url, sponsor_logo_url,
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE year_config SET
         year_label = COALESCE($1, year_label),
         age_group_config = COALESCE($2, age_group_config),
         grade_config = COALESCE($3, grade_config),
         rank_points_config = COALESCE($4, rank_points_config),
         participation_bonus_pts = COALESCE($5, participation_bonus_pts),
         divergence_threshold_pct = COALESCE($6, divergence_threshold_pct),
         teacher_name_deadline = COALESCE($7, teacher_name_deadline),
         kca_logo_url = COALESCE($8, kca_logo_url),
         sponsor_logo_url = COALESCE($9, sponsor_logo_url)
       WHERE year_id = $10 RETURNING *`,
      [year_label, age_group_config, grade_config, rank_points_config,
        participation_bonus_pts, divergence_threshold_pct, teacher_name_deadline,
        kca_logo_url, sponsor_logo_url, req.params.year_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Year config not found' });

    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'UPDATE_CONFIG', entity: 'year_config', entityId: req.params.year_id, details: req.body });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/config/:year_id/publish
router.post('/config/:year_id/publish', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE year_config SET status = 'published' WHERE year_id = $1 RETURNING *`,
      [req.params.year_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Year config not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'PUBLISH_CONFIG', entity: 'year_config', entityId: req.params.year_id });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/config/:year_id/freeze
router.post('/config/:year_id/freeze', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE year_config SET status = 'frozen' WHERE year_id = $1 RETURNING *`,
      [req.params.year_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Year config not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'FREEZE_CONFIG', entity: 'year_config', entityId: req.params.year_id });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/archive/:year_id
router.post('/archive/:year_id', requireRole('SuperAdmin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE year_config SET status = 'archived' WHERE year_id = $1 RETURNING *`,
      [req.params.year_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Year config not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'ARCHIVE_YEAR', entity: 'year_config', entityId: req.params.year_id });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/init-year
router.post('/init-year', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const {
      year_id, year_label, age_group_config, grade_config, rank_points_config,
      participation_bonus_pts, divergence_threshold_pct, teacher_name_deadline,
      kca_logo_url, sponsor_logo_url,
    } = req.body;
    if (!year_id || !year_label) return res.status(400).json({ error: 'year_id and year_label are required' });

    const { rows } = await pool.query(
      `INSERT INTO year_config
        (year_id, year_label, age_group_config, grade_config, rank_points_config,
         participation_bonus_pts, divergence_threshold_pct, teacher_name_deadline,
         kca_logo_url, sponsor_logo_url, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft', NOW())
       RETURNING *`,
      [year_id, year_label, age_group_config, grade_config, rank_points_config,
        participation_bonus_pts, divergence_threshold_pct, teacher_name_deadline,
        kca_logo_url, sponsor_logo_url]
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'INIT_YEAR', entity: 'year_config', entityId: year_id });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/schedule/generate-draft  -> calls scheduler.js (rule #26)
router.post('/schedule/generate-draft', requireRole('SuperAdmin', 'Admin', 'Coordinator'), async (req, res, next) => {
  try {
    const { year_id } = req.body;
    if (!year_id) return res.status(400).json({ error: 'year_id is required' });
    const result = await generateDraftSchedule(year_id);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'GENERATE_DRAFT_SCHEDULE', entity: 'schedule_draft', entityId: year_id });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/schedule/draft/:year_id
router.get('/schedule/draft/:year_id', requireRole('SuperAdmin', 'Admin', 'Coordinator', 'Chairman'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT sd.*, e.name AS event_name, e.category, e.age_group
       FROM schedule_draft sd JOIN events e ON e.id = sd.event_id
       WHERE sd.year_id = $1 ORDER BY sd.placement_order`,
      [req.params.year_id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/schedule/:event_id  (update placement)
router.put('/schedule/:event_id', requireRole('SuperAdmin', 'Admin', 'Coordinator'), async (req, res, next) => {
  try {
    const { placement_order, venue, time_slot_id } = req.body;
    const { rows } = await pool.query(
      `UPDATE schedule_draft SET
         placement_order = COALESCE($1, placement_order),
         venue = COALESCE($2, venue),
         time_slot_id = COALESCE($3, time_slot_id)
       WHERE event_id = $4 RETURNING *`,
      [placement_order, venue, time_slot_id, req.params.event_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Draft entry not found for this event' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'UPDATE_SCHEDULE_PLACEMENT', entity: 'schedule_draft', entityId: req.params.event_id, details: req.body });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/schedule/publish/:year_id
router.post('/schedule/publish/:year_id', requireRole('SuperAdmin', 'Admin', 'Chairman'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE schedule_draft SET status = 'published', published_at = NOW()
       WHERE year_id = $1 AND status = 'draft' RETURNING event_id`,
      [req.params.year_id]
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'PUBLISH_SCHEDULE', entity: 'schedule_draft', entityId: req.params.year_id });
    res.json({ publishedEvents: rows.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

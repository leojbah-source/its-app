// src/routes/admin.config.routes.js  (mounted at /api/admin)
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { generateDraftSchedule } = require('../services/scheduler');

const router = express.Router();
router.use(authenticate);
const n = v => (v === '' || v === undefined || v === null) ? null : v;
async function getActiveConfig() {
  const { rows } = await pool.query(`SELECT * FROM year_config WHERE is_active = TRUE LIMIT 1`);
  return rows[0] || null;
}
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(__dirname, '../../public/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${req.body.field || 'asset'}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});
// GET /api/admin/config/active
// GET /api/admin/config/active
router.get('/config/active', requireRole('SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'), async (req, res, next) => {
  try {
    const config = await getActiveConfig();
    if (!config) return res.status(404).json({ error: 'No active year config. Run init-year first.' });

    const { rows: age_groups } = await pool.query(
      `SELECT code, label, dob_from, dob_to, sort_order
       FROM age_groups WHERE year_id = $1 ORDER BY sort_order, code`,
      [config.id]
    );

    res.json({ ...config, age_groups });
  } catch (err) { next(err); }
});
// PUT /api/admin/config/active
router.put('/config/active', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const config = await getActiveConfig();
    if (!config) return res.status(404).json({ error: 'No active year config found' });

    // Extract flat values — frontend sends nested format (grades[], rank_points{})
    const event_year_label        = n(req.body.event_year_label);
    const event_start_date        = n(req.body.event_start_date);
    const event_end_date          = n(req.body.event_end_date);
    const kca_logo_url            = n(req.body.assets?.kca_logo?.url      ?? req.body.kca_logo_url);
    const its_logo_url            = n(req.body.assets?.its_logo?.url      ?? req.body.its_logo_url);
    const sponsor_logo_url        = n(req.body.assets?.sponsor_logo?.url  ?? req.body.sponsor_logo_url);
    const sponsor_name            = n(req.body.sponsor_name);
    const kca_iban                = n(req.body.kca_iban);
    const benefit_pay_number      = n(req.body.benefit_pay_number);
    const max_individual_events   = n(req.body.max_individual_events);
    const category_cap            = n(req.body.category_cap);
    const kca_special_min_points  = n(req.body.kca_special_min_points);
    const min_entries_threshold   = n(req.body.min_entries_threshold);
    const split_threshold         = n(req.body.split_threshold);
    const no_prize_below          = n(req.body.no_prize_below);
    const rank_pts_first          = n(req.body.rank_pts_first  ?? req.body.rank_points?.first);
    const rank_pts_second         = n(req.body.rank_pts_second ?? req.body.rank_points?.second);
    const rank_pts_third          = n(req.body.rank_pts_third  ?? req.body.rank_points?.third);
    const participation_bonus_pts = n(req.body.participation_bonus_pts);
    const grade_a_pct             = n(req.body.grade_a_pct ?? req.body.grades?.[0]?.min_percent);
    const grade_b_pct             = n(req.body.grade_b_pct ?? req.body.grades?.[1]?.min_percent);
    const grade_c_pct             = n(req.body.grade_c_pct ?? req.body.grades?.[2]?.min_percent);
    const grade_a_pts             = n(req.body.grade_a_pts ?? req.body.grades?.[0]?.points);
    const grade_b_pts             = n(req.body.grade_b_pts ?? req.body.grades?.[1]?.points);
    const grade_c_pts             = n(req.body.grade_c_pts ?? req.body.grades?.[2]?.points);
    const divergence_threshold_pct= n(req.body.divergence_threshold_pct);
    const tiebreaker_scale_max    = n(req.body.tiebreaker_scale_max);
    const reg_deadline            = n(req.body.reg_deadline);
    const team_reg_deadline       = n(req.body.team_reg_deadline);
    const teacher_name_deadline   = n(req.body.teacher_name_deadline);
    const result_template_url     = n(req.body.assets?.result_template?.url ?? req.body.result_template_url);
    const photo_crop_width        = n(req.body.photo_crop_width);
    const photo_crop_height       = n(req.body.photo_crop_height);

    const { rows } = await pool.query(
      `UPDATE year_config SET
         event_year_label         = COALESCE($1,  event_year_label),
         event_start_date         = COALESCE($2,  event_start_date),
         event_end_date           = COALESCE($3,  event_end_date),
         kca_logo_url             = COALESCE($4,  kca_logo_url),
         its_logo_url             = COALESCE($5, its_logo_url),
         sponsor_logo_url         = COALESCE($6,  sponsor_logo_url),
         sponsor_name             = COALESCE($7,  sponsor_name),
         kca_iban                 = COALESCE($8,  kca_iban),
         benefit_pay_number       = COALESCE($9,  benefit_pay_number),
         max_individual_events    = COALESCE($10,  max_individual_events),
         category_cap             = COALESCE($11, category_cap),
         kca_special_min_points   = COALESCE($12, kca_special_min_points),
         min_entries_threshold    = COALESCE($13, min_entries_threshold),
         split_threshold          = COALESCE($14, split_threshold),
         no_prize_below           = COALESCE($15, no_prize_below),
         rank_pts_first           = COALESCE($16, rank_pts_first),
         rank_pts_second          = COALESCE($17, rank_pts_second),
         rank_pts_third           = COALESCE($18, rank_pts_third),
         participation_bonus_pts  = COALESCE($19, participation_bonus_pts),
         grade_a_pct              = COALESCE($20, grade_a_pct),
         grade_b_pct              = COALESCE($21, grade_b_pct),
         grade_c_pct              = COALESCE($22, grade_c_pct),
         grade_a_pts              = COALESCE($23, grade_a_pts),
         grade_b_pts              = COALESCE($24, grade_b_pts),
         grade_c_pts              = COALESCE($25, grade_c_pts),
         divergence_threshold_pct = COALESCE($26, divergence_threshold_pct),
         tiebreaker_scale_max     = COALESCE($27, tiebreaker_scale_max),
         reg_deadline             = COALESCE($28, reg_deadline),
         team_reg_deadline        = COALESCE($29, team_reg_deadline),
         teacher_name_deadline    = COALESCE($30, teacher_name_deadline),
         result_template_url      = COALESCE($31, result_template_url),
         photo_crop_width         = COALESCE($32, photo_crop_width),
         photo_crop_height        = COALESCE($33, photo_crop_height),
         updated_at               = NOW()
       WHERE id = $34 RETURNING *`,
      [event_year_label, event_start_date, event_end_date,
       kca_logo_url, its_logo_url, sponsor_logo_url, sponsor_name, kca_iban, benefit_pay_number,
       max_individual_events, category_cap, kca_special_min_points,
       min_entries_threshold, split_threshold, no_prize_below,
       rank_pts_first, rank_pts_second, rank_pts_third, participation_bonus_pts,
       grade_a_pct, grade_b_pct, grade_c_pct, grade_a_pts, grade_b_pts, grade_c_pts,
       divergence_threshold_pct, tiebreaker_scale_max,
       reg_deadline, team_reg_deadline, teacher_name_deadline,
       result_template_url, photo_crop_width, photo_crop_height,
       config.id]
    );
    // Upsert age groups
    if (Array.isArray(req.body.age_groups) && req.body.age_groups.length) {
      await pool.query(`DELETE FROM age_groups WHERE year_id = $1`, [config.id]);
      for (const [i, ag] of req.body.age_groups.entries()) {
        await pool.query(
          `INSERT INTO age_groups (year_id, code, label, dob_from, dob_to, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [config.id, ag.code, ag.label || null, n(ag.dob_from), n(ag.dob_to), i + 1]
        );
      }
    }
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'UPDATE_CONFIG', entity: 'year_config', entityId: config.id, details: req.body });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/admin/config/active/publish
router.post('/config/active/publish', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const config = await getActiveConfig();
    if (!config) return res.status(404).json({ error: 'No active year config found' });
    const { rows } = await pool.query(
      `UPDATE year_config SET initial_list_published = TRUE, initial_list_published_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`, [config.id]
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'PUBLISH_CONFIG', entity: 'year_config', entityId: config.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/admin/config/active/freeze
router.post('/config/active/freeze', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const config = await getActiveConfig();
    if (!config) return res.status(404).json({ error: 'No active year config found' });
    const { rows } = await pool.query(
      `UPDATE year_config SET reg_deadline = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`, [config.id]
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'FREEZE_REGISTRATIONS', entity: 'year_config', entityId: config.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// GET /api/admin/config/:id
router.get('/config/:id', requireRole('SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM year_config WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Year config not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/admin/config/:id
router.put('/config/:id', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const { event_year_label, rank_pts_first, rank_pts_second, rank_pts_third,
            participation_bonus_pts, divergence_threshold_pct, teacher_name_deadline,
            kca_logo_url, sponsor_logo_url } = req.body;
    const { rows } = await pool.query(
      `UPDATE year_config SET
         event_year_label        = COALESCE($1, event_year_label),
         rank_pts_first          = COALESCE($2, rank_pts_first),
         rank_pts_second         = COALESCE($3, rank_pts_second),
         rank_pts_third          = COALESCE($4, rank_pts_third),
         participation_bonus_pts = COALESCE($5, participation_bonus_pts),
         divergence_threshold_pct= COALESCE($6, divergence_threshold_pct),
         teacher_name_deadline   = COALESCE($7, teacher_name_deadline),
         kca_logo_url            = COALESCE($8, kca_logo_url),
         sponsor_logo_url        = COALESCE($9, sponsor_logo_url),
         updated_at              = NOW()
       WHERE id = $10 RETURNING *`,
      [event_year_label, rank_pts_first, rank_pts_second, rank_pts_third,
       participation_bonus_pts, divergence_threshold_pct, teacher_name_deadline,
       kca_logo_url, sponsor_logo_url, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Year config not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'UPDATE_CONFIG', entity: 'year_config', entityId: req.params.id, details: req.body });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/admin/config/:id/publish
router.post('/config/:id/publish', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE year_config SET initial_list_published = TRUE, initial_list_published_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Year config not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'PUBLISH_CONFIG', entity: 'year_config', entityId: req.params.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/admin/config/:id/freeze
router.post('/config/:id/freeze', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE year_config SET reg_deadline = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Year config not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'FREEZE_REGISTRATIONS', entity: 'year_config', entityId: req.params.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/admin/archive/:id
router.post('/archive/:id', requireRole('SuperAdmin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE year_config SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING *`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Year config not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'ARCHIVE_YEAR', entity: 'year_config', entityId: req.params.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/admin/init-year
router.post('/init-year', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const { year, event_year_label } = req.body;
    if (!year) return res.status(400).json({ error: 'year is required' });
    const { rows } = await pool.query(
      `INSERT INTO year_config (year, event_year_label, is_active, created_at, updated_at)
       VALUES ($1, $2, TRUE, NOW(), NOW()) RETURNING *`,
      [year, event_year_label || `ITS ${year}`]
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'INIT_YEAR', entity: 'year_config', entityId: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/admin/schedule/generate-draft
router.post('/schedule/generate-draft', requireRole('SuperAdmin', 'Admin', 'Coordinator'), async (req, res, next) => {
  try {
    const { year_id } = req.body;
    if (!year_id) return res.status(400).json({ error: 'year_id is required' });
    const result = await generateDraftSchedule(year_id);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'GENERATE_DRAFT_SCHEDULE', entity: 'schedule', entityId: year_id });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/schedule/draft/:year_id
router.get('/schedule/draft/:year_id', requireRole('SuperAdmin', 'Admin', 'Coordinator', 'Chairman'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, e.event_name, e.category_id FROM schedule s
       JOIN events e ON e.id = s.event_id
       WHERE s.year_config_id = $1 ORDER BY s.slot_order`,
      [req.params.year_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/admin/schedule/publish/:year_id
router.post('/schedule/publish/:year_id', requireRole('SuperAdmin', 'Admin', 'Chairman'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE schedule SET is_published = TRUE WHERE year_config_id = $1 AND is_published = FALSE RETURNING event_id`,
      [req.params.year_id]
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'PUBLISH_SCHEDULE', entity: 'schedule', entityId: req.params.year_id });
    res.json({ publishedEvents: rows.length });
  } catch (err) { next(err); }
});
// POST /api/admin/config/upload
router.post('/config/upload', requireRole('SuperAdmin', 'Admin'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const protocol = req.protocol;
    const host = req.get('host');
    const url = `${protocol}://${host}/uploads/${req.file.filename}`;
    res.json({ url, name: req.file.originalname });
  } catch (err) { next(err); }
});

module.exports = router;
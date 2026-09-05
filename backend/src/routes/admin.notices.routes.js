// src/routes/admin.notices.routes.js  (mounted at /api/admin/notices)
// Admin CRUD for public board announcements. Public visibility is gated by
// is_active and surfaced by GET /api/public/notices.
const express = require('express');
const path = require('path');
const multer = require('multer');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);
const viewRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'];
const editRoles = ['SuperAdmin', 'Admin', 'Chairman'];

// Notice attachment upload — PDF or JPEG/PNG, saved to /public/uploads and served
// at /uploads/<file>. NOTE: on ephemeral hosts (Render free) this folder is wiped
// on redeploy; use S3/object storage for go-live.
const uploadDir = path.join(__dirname, '../../public/uploads');
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png'];
const noticeUpload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) =>
      cb(null, `notice_${Date.now()}_${Math.round(Math.random() * 1e6)}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    ALLOWED.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only PDF, JPEG or PNG files are allowed')),
});

// POST /api/admin/notices/upload -> { url, type }  (multipart field: file)
router.post('/upload', requireRole(...editRoles), noticeUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received (PDF/JPEG/PNG, max 10 MB)' });
  const type = req.file.mimetype === 'application/pdf' ? 'pdf' : 'image';
  res.json({ url: `/uploads/${req.file.filename}`, type });
});

async function resolveYearId(v) {
  if (v && v !== 'active') return Number(v);
  const { rows } = await pool.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
  return rows[0]?.id || null;
}

// GET /api/admin/notices?year_id=   (all notices incl. inactive, for admin)
router.get('/', requireRole(...viewRoles), async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.query.year_id);
    if (!yearId) return res.json([]);
    const { rows } = await pool.query(
      `SELECT n.id, n.title, n.body, n.is_active, n.posted_at,
              n.attachment_url, n.attachment_type, u.full_name AS posted_by_name
       FROM notices n LEFT JOIN users u ON u.id = n.posted_by
       WHERE n.year_id = $1 ORDER BY n.posted_at DESC`, [yearId]);
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/admin/notices  { year_id?, title, body }
router.post('/', requireRole(...editRoles), async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.body.year_id);
    if (!yearId) return res.status(400).json({ error: 'No active year' });
    const { title, body, attachment_url, attachment_type } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
    const { rows } = await pool.query(
      `INSERT INTO notices (year_id, title, body, posted_by, attachment_url, attachment_type)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [yearId, title.trim(), (body || '').trim() || null, req.user.id,
       attachment_url || null, attachment_url ? (attachment_type || 'pdf') : null]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CREATE_NOTICE', entity: 'notices', entityId: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/admin/notices/:id  { title?, body?, is_active? }
router.put('/:id', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { title, body, is_active, attachment_url, attachment_type } = req.body;
    const { rows } = await pool.query(
      `UPDATE notices SET
         title = COALESCE($1, title),
         body = COALESCE($2, body),
         is_active = COALESCE($3, is_active),
         attachment_url = COALESCE($5, attachment_url),
         attachment_type = COALESCE($6, attachment_type)
       WHERE id = $4 RETURNING *`,
      [title ?? null, body ?? null, typeof is_active === 'boolean' ? is_active : null, req.params.id,
       attachment_url ?? null, attachment_type ?? null]);
    if (!rows[0]) return res.status(404).json({ error: 'Notice not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'UPDATE_NOTICE', entity: 'notices', entityId: req.params.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/admin/notices/:id
router.delete('/:id', requireRole('SuperAdmin', 'Admin', 'Chairman'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`DELETE FROM notices WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Notice not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'DELETE_NOTICE', entity: 'notices', entityId: req.params.id });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;

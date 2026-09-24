// src/routes/admin.notices.routes.js  (mounted at /api/admin/notices)
// Admin CRUD for public board announcements. Public visibility is gated by
// is_active and surfaced by GET /api/public/notices.
const express = require('express');
const path = require('path');
const multer = require('multer');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { uploadDir } = require('../utils/uploads');
const { sendWhatsApp, sendWhatsAppChat, groupChatId } = require('../utils/notify');

const router = express.Router();
router.use(authenticate);
const viewRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'];
const editRoles = ['SuperAdmin', 'Admin', 'Chairman'];

// Notice attachment upload — PDF or JPEG/PNG, written to the persistent upload
// dir (Render disk in prod) and served at /uploads/<file>. See utils/uploads.js.
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


// ── WhatsApp broadcast + saved groups ────────────────────────────────────────
// Recipient list for a criteria selection (completed registrations, active year,
// with a guardian phone), deduped by phone. All criteria combine with AND.
async function resolveAudience(yearId, criteria = {}) {
  const args = [yearId];
  const where = ['p.year_id = $1', 'p.confirmed_at IS NOT NULL',
                 "p.guardian_phone IS NOT NULL", "p.guardian_phone <> ''"];
  const add = (v) => { args.push(v); return `$${args.length}`; };

  if (Array.isArray(criteria.age_group_ids) && criteria.age_group_ids.length)
    where.push(`p.age_group_id = ANY(${add(criteria.age_group_ids)})`);
  if (Array.isArray(criteria.school_ids) && criteria.school_ids.length)
    where.push(`p.school_id = ANY(${add(criteria.school_ids)})`);
  if (criteria.cpr)
    where.push(`COALESCE(p.admin_verified_status, 'pending') = ${add(criteria.cpr)}`);
  if (Array.isArray(criteria.event_ids) && criteria.event_ids.length)
    where.push(`EXISTS (SELECT 1 FROM registrations r WHERE r.participant_id = p.id
                        AND r.event_id = ANY(${add(criteria.event_ids)})
                        AND r.status NOT IN ('withdrawn','swapped'))`);
  if (Array.isArray(criteria.participant_ids) && criteria.participant_ids.length)
    where.push(`p.id = ANY(${add(criteria.participant_ids)})`);
  if (criteria.payment === 'paid')
    where.push(`EXISTS (SELECT 1 FROM payments pay WHERE pay.participant_id = p.id AND pay.status = 'confirmed')`);
  else if (criteria.payment === 'unpaid')
    where.push(`NOT EXISTS (SELECT 1 FROM payments pay WHERE pay.participant_id = p.id AND pay.status = 'confirmed')`);
  else if (criteria.payment === 'pending')
    where.push(`EXISTS (SELECT 1 FROM payments pay WHERE pay.participant_id = p.id AND pay.status = 'pending')`);

  const sql = `SELECT DISTINCT ON (p.guardian_phone) p.id, p.full_name AS name, p.guardian_phone AS phone
               FROM participants p
               WHERE ${where.join(' AND ')}
               ORDER BY p.guardian_phone, p.full_name`;
  const { rows } = await pool.query(sql, args);
  return rows;
}

// GET /api/admin/notices/lookups — options for the audience picker
router.get('/lookups', requireRole(...viewRoles), async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.query.year_id);
    if (!yearId) return res.json({ ageGroups: [], events: [], schools: [] });
    const [ag, ev, sc] = await Promise.all([
      pool.query(`SELECT id, code, label FROM age_groups WHERE year_id = $1 ORDER BY sort_order, code`, [yearId]),
      pool.query(`SELECT id, event_code, event_name FROM events WHERE year_id = $1 ORDER BY event_code`, [yearId]),
      pool.query(`SELECT id, name FROM schools WHERE is_active = TRUE ORDER BY name`),
    ]);
    res.json({ ageGroups: ag.rows, events: ev.rows, schools: sc.rows });
  } catch (err) { next(err); }
});

// POST /api/admin/notices/audience/preview  { criteria }
router.post('/audience/preview', requireRole(...editRoles), async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.body.year_id);
    if (!yearId) return res.json({ count: 0, sample: [] });
    const rows = await resolveAudience(yearId, req.body.criteria || {});
    res.json({ count: rows.length, sample: rows.slice(0, 8).map((r) => ({ name: r.name, phone: r.phone })) });
  } catch (err) { next(err); }
});

// WhatsApp groups CRUD
router.get('/groups', requireRole(...viewRoles), async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.query.year_id);
    const { rows } = await pool.query(`SELECT id, name, chat_id FROM wa_groups WHERE year_id = $1 ORDER BY name`, [yearId]);
    res.json(rows);
  } catch (err) { next(err); }
});
router.post('/groups', requireRole(...editRoles), async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.body.year_id);
    const { name, chat_id } = req.body;
    if (!name || !name.trim() || !chat_id || !chat_id.trim())
      return res.status(400).json({ error: 'name and chat_id are required' });
    const { rows } = await pool.query(
      `INSERT INTO wa_groups (year_id, name, chat_id, created_by) VALUES ($1,$2,$3,$4) RETURNING id, name, chat_id`,
      [yearId, name.trim(), groupChatId(chat_id), req.user.id]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});
router.delete('/groups/:id', requireRole(...editRoles), async (req, res, next) => {
  try { await pool.query(`DELETE FROM wa_groups WHERE id = $1`, [req.params.id]); res.json({ deleted: true }); }
  catch (err) { next(err); }
});

// GET /api/admin/notices/sends — recent broadcast log
router.get('/sends', requireRole(...viewRoles), async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.query.year_id);
    const { rows } = await pool.query(
      `SELECT s.id, s.channel, s.audience, s.message, s.total_recipients, s.sent, s.failed, s.status, s.created_at,
              u.full_name AS by_name
       FROM notice_sends s LEFT JOIN users u ON u.id = s.created_by
       WHERE s.year_id = $1 ORDER BY s.created_at DESC LIMIT 20`, [yearId]);
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/admin/notices/send  { message, notice_id?, group_id?, criteria?, audience_label? }
router.post('/send', requireRole(...editRoles), async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.body.year_id);
    if (!yearId) return res.status(400).json({ error: 'No active year' });
    const message = (req.body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'message is required' });

    // Group post — a single message into a WhatsApp group chat.
    if (req.body.group_id) {
      const { rows: g } = await pool.query(`SELECT name, chat_id FROM wa_groups WHERE id = $1 AND year_id = $2`,
        [req.body.group_id, yearId]);
      if (!g[0]) return res.status(404).json({ error: 'Group not found' });
      const { rows: logRows } = await pool.query(
        `INSERT INTO notice_sends (year_id, notice_id, channel, audience, message, total_recipients, status, created_by)
         VALUES ($1,$2,'wa_group',$3,$4,1,'sending',$5) RETURNING id`,
        [yearId, req.body.notice_id || null, `Group: ${g[0].name}`, message, req.user.id]);
      const out = await sendWhatsAppChat(g[0].chat_id, message);
      const ok = out.delivered ? 1 : 0;
      await pool.query(`UPDATE notice_sends SET sent = $1, failed = $2, status = 'done' WHERE id = $3`,
        [ok, ok ? 0 : 1, logRows[0].id]);
      await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'SEND_WA_GROUP',
        entity: 'notices', entityId: req.body.notice_id || null, details: { group: g[0].name } });
      return res.json({ send_id: logRows[0].id, channel: 'wa_group', total: 1, delivered: ok });
    }

    // Criteria broadcast to individual parents.
    const rows = await resolveAudience(yearId, req.body.criteria || {});
    if (rows.length === 0) return res.status(400).json({ error: 'No recipients match that selection.' });
    if (rows.length > 2000) return res.status(400).json({ error: 'Too many recipients (over 2000). Please narrow the selection.' });

    const { rows: logRows } = await pool.query(
      `INSERT INTO notice_sends (year_id, notice_id, channel, audience, message, total_recipients, status, created_by)
       VALUES ($1,$2,'whatsapp',$3,$4,$5,'sending',$6) RETURNING id`,
      [yearId, req.body.notice_id || null, req.body.audience_label || 'Selected parents', message, rows.length, req.user.id]);
    const sendId = logRows[0].id;
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'SEND_WA_BROADCAST',
      entity: 'notices', entityId: req.body.notice_id || null, details: { total: rows.length } });

    // Respond immediately; deliver in the background with throttling to reduce
    // spam-flagging risk. Progress is polled via GET /sends.
    res.json({ send_id: sendId, channel: 'whatsapp', total: rows.length });

    (async () => {
      let sent = 0, failed = 0; const failedNums = [];
      for (const r of rows) {
        try {
          const out = await sendWhatsApp(r.phone, message);
          if (out.delivered) sent++; else { failed++; failedNums.push(r.phone); }
        } catch { failed++; failedNums.push(r.phone); }
        await new Promise((done) => setTimeout(done, 900));
        if ((sent + failed) % 10 === 0)
          await pool.query(`UPDATE notice_sends SET sent = $1, failed = $2 WHERE id = $3`, [sent, failed, sendId]).catch(() => {});
      }
      await pool.query(`UPDATE notice_sends SET sent = $1, failed = $2, failed_numbers = $3, status = 'done' WHERE id = $4`,
        [sent, failed, JSON.stringify(failedNums), sendId]).catch(() => {});
    })();
  } catch (err) { next(err); }
});

module.exports = router;

// src/routes/admin.video.routes.js  (mounted at /api/admin/video)
// Performance-video add-on. On Event Day a coordinator ticks which participants
// want a paid video of their performance and how they paid (cash / BenefitPay);
// the videographer (Media role) works the opted-in list, auto-refreshing, and
// ticks each as recorded; collected amounts roll into the Finance summary.
// Opt-in is one row per registration (an event+age-group entry).
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

// Same roles that mark attendance on Event Day may tick the video column.
const markRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman'];
// The videographer (Media) plus supervising staff may tick "recorded".
const recordRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Media'];
// Who may view the opted-in lists (videographer + staff).
const viewRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer', 'Media', 'Accountant'];

const METHODS = ['cash', 'benefitpay'];
const toInt = (v) => (v === '' || v === undefined || v === null ? null : Number(v));

async function activeYearId() {
  const { rows } = await pool.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
  return rows[0]?.id || null;
}
async function eventVideoEligible(eventId) {
  // Video recording applies only to dance events (category NATYA) and all team events.
  const { rows } = await pool.query(
    `SELECT e.event_kind, c.code AS category_code, c.name AS category_name
     FROM events e LEFT JOIN categories c ON c.id = e.category_id WHERE e.id = $1`, [eventId]);
  if (!rows[0]) return false;
  const r = rows[0];
  return r.event_kind === 'team'
    || /natya/i.test(r.category_code || '')
    || /dance/i.test(r.category_name || '');
}
async function currentFee() {
  const { rows } = await pool.query(`SELECT COALESCE(video_fee, 5.000) AS fee FROM year_config WHERE is_active = TRUE LIMIT 1`);
  return rows[0] ? Number(rows[0].fee) : 5.000;
}

// ── POST /api/admin/video/:event_id/request ──────────────────────────────────
// body: { registration_id, payment_method }  → opt a registration in (or update
// its payment method). Idempotent per registration.
router.post('/:event_id/request', requireRole(...markRoles), async (req, res, next) => {
  try {
    const regId = toInt(req.body.registration_id);
    const method = String(req.body.payment_method || '').toLowerCase();
    if (!regId) return res.status(400).json({ error: 'registration_id is required' });
    if (!METHODS.includes(method)) return res.status(400).json({ error: "payment_method must be 'cash' or 'benefitpay'" });

    const { rows: reg } = await pool.query(
      `SELECT id, year_id, event_id, age_group_id, status FROM registrations WHERE id = $1 AND event_id = $2`,
      [regId, req.params.event_id]);
    if (!reg[0]) return res.status(404).json({ error: 'Registration not found for this event' });
    if (['withdrawn', 'swapped'].includes(reg[0].status))
      return res.status(409).json({ error: 'This entry is withdrawn/swapped and cannot opt in for video.' });
    if (reg[0].status === 'absent')
      return res.status(409).json({ error: 'This participant is marked absent — mark them present before adding a video request.' });
    if (!(await eventVideoEligible(reg[0].event_id)))
      return res.status(409).json({ error: 'Video recording applies only to dance and team events.' });

    const fee = await currentFee();
    const { rows } = await pool.query(
      `INSERT INTO video_requests
         (year_id, registration_id, event_id, age_group_id, amount, payment_method, collected_by, collected_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now())
       ON CONFLICT (registration_id) DO UPDATE SET
         payment_method = EXCLUDED.payment_method,
         collected_by   = EXCLUDED.collected_by,
         collected_at   = now(),
         updated_at     = now()
       RETURNING *`,
      [reg[0].year_id, regId, reg[0].event_id, reg[0].age_group_id, fee, method, req.user.id]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'VIDEO_OPT_IN', entity: 'video_requests', entityId: rows[0].id, details: { registration_id: regId, payment_method: method } });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ── PUT /api/admin/video/request/:registration_id — change payment method ────
router.put('/request/:registration_id', requireRole(...markRoles), async (req, res, next) => {
  try {
    const method = String(req.body.payment_method || '').toLowerCase();
    if (!METHODS.includes(method)) return res.status(400).json({ error: "payment_method must be 'cash' or 'benefitpay'" });
    const { rows } = await pool.query(
      `UPDATE video_requests SET payment_method = $1, updated_at = now()
       WHERE registration_id = $2 RETURNING *`,
      [method, req.params.registration_id]);
    if (!rows[0]) return res.status(404).json({ error: 'No video request for this registration' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'VIDEO_METHOD', entity: 'video_requests', entityId: rows[0].id, details: { payment_method: method } });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/video/request/:registration_id — opt out / undo tick ───
router.delete('/request/:registration_id', requireRole(...markRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM video_requests WHERE registration_id = $1 RETURNING id`, [req.params.registration_id]);
    if (!rows[0]) return res.status(404).json({ error: 'No video request for this registration' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'VIDEO_OPT_OUT', entity: 'video_requests', entityId: rows[0].id });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ── PUT /api/admin/video/request/:registration_id/recorded — videographer tick ─
// body: { recorded: true|false }
router.put('/request/:registration_id/recorded', requireRole(...recordRoles), async (req, res, next) => {
  try {
    const recorded = req.body.recorded !== false;
    const { rows } = await pool.query(
      `UPDATE video_requests SET
         recorded = $1,
         recorded_by = CASE WHEN $1 THEN $2 ELSE NULL END,
         recorded_at = CASE WHEN $1 THEN now() ELSE NULL END,
         updated_at = now()
       WHERE registration_id = $3 RETURNING *`,
      [recorded, req.user.id, req.params.registration_id]);
    if (!rows[0]) return res.status(404).json({ error: 'No video request for this registration' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'VIDEO_RECORDED', entity: 'video_requests', entityId: rows[0].id, details: { recorded } });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/admin/video/requests — opted-in list (videographer + prep) ──────
// filters: ?event_id=&age_group_id=&recorded=true|false&year_id=  ?format=csv
router.get('/requests', requireRole(...viewRoles), async (req, res, next) => {
  try {
    const eventId = toInt(req.query.event_id);
    const ageGroupId = toInt(req.query.age_group_id);
    const yearId = toInt(req.query.year_id) || (await activeYearId());
    const recordedFilter = req.query.recorded === 'true' ? true : req.query.recorded === 'false' ? false : null;

    const { rows } = await pool.query(
      `SELECT vr.id, vr.registration_id, vr.event_id, vr.age_group_id,
              vr.amount, vr.payment_method, vr.recorded,
              vr.collected_at, vr.recorded_at,
              COALESCE(p.full_name, t.team_name) AS name,
              e.event_code AS event_code, e.event_name AS event_name,
              ag.code AS age_group, ag.label AS age_group_label,
              ca.chest_number,
              cu.full_name AS collected_by_name,
              ru.full_name AS recorded_by_name,
              (SELECT to_char(MIN(s.event_date), 'YYYY-MM-DD') FROM schedule s WHERE s.event_id = vr.event_id) AS event_date
       FROM video_requests vr
       JOIN registrations r ON r.id = vr.registration_id
       LEFT JOIN participants p ON p.id = r.participant_id
       LEFT JOIN teams t ON t.id = r.team_id
       LEFT JOIN events e ON e.id = vr.event_id
       LEFT JOIN age_groups ag ON ag.id = vr.age_group_id
       LEFT JOIN chest_assignments ca ON ca.registration_id = vr.registration_id
       LEFT JOIN users cu ON cu.id = vr.collected_by
       LEFT JOIN users ru ON ru.id = vr.recorded_by
       WHERE vr.year_id = $1
         AND ($2::int IS NULL OR vr.event_id = $2)
         AND ($3::int IS NULL OR vr.age_group_id = $3)
         AND ($4::boolean IS NULL OR vr.recorded = $4)
       ORDER BY event_date NULLS LAST, e.code, ag.sort_order, ca.chest_number NULLS LAST, name`,
      [yearId, eventId, ageGroupId, recordedFilter]);

    if (req.query.format === 'csv') {
      const cols = ['event_date', 'event_code', 'event_name', 'age_group', 'chest_number', 'name', 'payment_method', 'amount', 'recorded', 'collected_by_name', 'recorded_by_name'];
      const header = cols.join(',');
      const body = rows.map((r) => cols.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','));
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="video-requests${eventId ? '-event-' + eventId : ''}.csv"`);
      return res.send([header, ...body].join('\n'));
    }
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/video/finance-summary?year_id= — totals for Finance ───────
router.get('/finance-summary', requireRole(...viewRoles), async (req, res, next) => {
  try {
    const yearId = toInt(req.query.year_id) || (await activeYearId());
    if (!yearId) return res.json({ yearId: null, count: 0, total: 0, byMethod: { cash: 0, benefitpay: 0 }, byCollector: [] });

    const { rows: tot } = await pool.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(amount), 0) AS total,
              COALESCE(SUM(amount) FILTER (WHERE payment_method = 'cash'), 0) AS cash,
              COALESCE(SUM(amount) FILTER (WHERE payment_method = 'benefitpay'), 0) AS benefitpay
       FROM video_requests WHERE year_id = $1`, [yearId]);
    const { rows: byCollector } = await pool.query(
      `SELECT vr.collected_by, u.full_name AS collector,
              COUNT(*)::int AS count,
              COALESCE(SUM(vr.amount), 0) AS total,
              COALESCE(SUM(vr.amount) FILTER (WHERE vr.payment_method = 'cash'), 0) AS cash,
              COALESCE(SUM(vr.amount) FILTER (WHERE vr.payment_method = 'benefitpay'), 0) AS benefitpay
       FROM video_requests vr LEFT JOIN users u ON u.id = vr.collected_by
       WHERE vr.year_id = $1
       GROUP BY vr.collected_by, u.full_name
       ORDER BY total DESC`, [yearId]);

    res.json({
      yearId,
      count: tot[0].count,
      total: Number(tot[0].total),
      byMethod: { cash: Number(tot[0].cash), benefitpay: Number(tot[0].benefitpay) },
      byCollector: byCollector.map((r) => ({
        collector: r.collector || '(unknown)',
        count: r.count, total: Number(r.total),
        cash: Number(r.cash), benefitpay: Number(r.benefitpay),
      })),
    });
  } catch (err) { next(err); }
});

module.exports = router;

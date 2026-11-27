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
const markRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'EventStaff'];
// The videographer (Media) plus supervising staff may tick "recorded".
const recordRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Media'];
// Who may view the opted-in lists (videographer + staff).
const viewRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Media', 'Accountant'];

const METHODS = ['cash', 'benefitpay'];
const toInt = (v) => (v === '' || v === undefined || v === null ? null : Number(v));

async function activeYearId() {
  const { rows } = await pool.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
  return rows[0]?.id || null;
}
async function eventVideoEligible(eventId) {
  // Video recording applies to dance events (category NATYA), all team events, and Fashion Show.
  const { rows } = await pool.query(
    `SELECT e.event_kind, e.event_name, c.code AS category_code, c.name AS category_name
     FROM events e LEFT JOIN categories c ON c.id = e.category_id WHERE e.id = $1`, [eventId]);
  if (!rows[0]) return false;
  const r = rows[0];
  return r.event_kind === 'team'
    || /natya/i.test(r.category_code || '')
    || /dance/i.test(r.category_name || '')
    || /fashion/i.test(r.event_name || '');
}
async function currentFee() {
  const { rows } = await pool.query(`SELECT COALESCE(video_fee, 5.000) AS fee FROM year_config WHERE is_active = TRUE LIMIT 1`);
  return rows[0] ? Number(rows[0].fee) : 5.000;
}
// Per-event video fee. Fashion Show runs ~3 minutes, so its fee is BHD 3 rather
// than the standard year fee (BHD 5) used for dance/team events.
async function eventVideoFee(eventId) {
  const { rows } = await pool.query(`SELECT event_name FROM events WHERE id = $1`, [eventId]);
  if (rows[0] && /fashion/i.test(rows[0].event_name || '')) return 3.000;
  return currentFee();
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
      return res.status(409).json({ error: 'Video recording applies only to dance, team and Fashion Show events.' });

    const fee = await eventVideoFee(reg[0].event_id);
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

// ── PUT /api/admin/video/request/:registration_id/amount — adjust the fee ────
// Lets a coordinator change the video fee (e.g. a sibling/family discount) so
// the recorded amount matches what was actually collected. Feeds Finance.
router.put('/request/:registration_id/amount', requireRole(...markRoles), async (req, res, next) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 0)
      return res.status(400).json({ error: 'amount must be a number of 0 or more' });
    const { rows } = await pool.query(
      `UPDATE video_requests SET amount = $1, updated_at = now()
        WHERE registration_id = $2 RETURNING *`, [amount.toFixed(3), req.params.registration_id]);
    if (!rows[0]) return res.status(404).json({ error: 'No video request for this registration' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'VIDEO_AMOUNT', entity: 'video_requests', entityId: rows[0].id, details: { amount } });
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
         recorded = $1::boolean,
         recorded_by = CASE WHEN $1::boolean THEN $2::int ELSE NULL END,
         recorded_at = CASE WHEN $1::boolean THEN now() ELSE NULL END,
         updated_at = now()
       WHERE registration_id = $3::int RETURNING *`,
      [recorded, req.user.id, req.params.registration_id]);
    if (!rows[0]) return res.status(404).json({ error: 'No video request for this registration' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'VIDEO_RECORDED', entity: 'video_requests', entityId: rows[0].id, details: { recorded } });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── PUT /api/admin/video/request/:registration_id/link — attach a share link ──
// The videographer (Media) pastes a link (Google Drive etc.); parents then see a
// Download button in their portal. An empty url clears it.
router.put('/request/:registration_id/link', requireRole(...recordRoles), async (req, res, next) => {
  try {
    const raw = (req.body.url || '').trim();
    if (raw && !/^https?:\/\//i.test(raw)) return res.status(400).json({ error: 'Enter a full link starting with http:// or https://' });
    const url = raw || null;
    const { rows } = await pool.query(
      `UPDATE video_requests
          SET video_url = $1,
              video_added_at = CASE WHEN $1 IS NULL THEN NULL ELSE now() END,
              video_added_by = CASE WHEN $1 IS NULL THEN NULL ELSE $2::int END,
              updated_at = now()
        WHERE registration_id = $3 RETURNING id, video_url`,
      [url, req.user.id, req.params.registration_id]);
    if (!rows[0]) return res.status(404).json({ error: 'Video request not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: url ? 'VIDEO_LINK_SET' : 'VIDEO_LINK_CLEARED', entity: 'video_requests', entityId: rows[0].id, details: {} });
    res.json({ ok: true, video_url: rows[0].video_url });
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
              vr.amount, vr.payment_method, vr.recorded, vr.video_url,
              vr.collected_at, vr.recorded_at,
              COALESCE(p.full_name, t.team_name) AS name,
              e.event_code AS event_code, e.event_name AS event_name,
              ag.code AS age_group, ag.label AS age_group_label,
              ca.chest_number,
              cu.full_name AS collected_by_name,
              ru.full_name AS recorded_by_name,
              pu.phone AS mobile, pu.whatsapp_number AS whatsapp, pu.email AS email,
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
       LEFT JOIN users pu ON pu.id = COALESCE(p.created_by, t.created_by)
       WHERE vr.year_id = $1
         AND ($2::int IS NULL OR vr.event_id = $2)
         AND ($3::int IS NULL OR vr.age_group_id = $3)
         AND ($4::boolean IS NULL OR vr.recorded = $4)
       ORDER BY event_date NULLS LAST, e.event_code, ag.sort_order, ca.chest_number NULLS LAST, name`,
      [yearId, eventId, ageGroupId, recordedFilter]);

    if (req.query.format === 'csv') {
      // No amount here — this CSV is for the videographer. Amounts are in the Finance Excel.
      const cols = ['event_date', 'event_code', 'event_name', 'age_group', 'chest_number', 'name', 'mobile', 'whatsapp', 'email', 'payment_method', 'recorded', 'collected_by_name', 'recorded_by_name'];
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

// ── GET /api/admin/video/collections-xlsx?year_id= — Finance detail (amounts) ─
router.get('/collections-xlsx', requireRole(...viewRoles), async (req, res, next) => {
  try {
    const yearId = toInt(req.query.year_id) || (await activeYearId());
    if (!yearId) return res.status(400).json({ error: 'No active year' });
    const { rows: yc } = await pool.query(`SELECT event_year_label FROM year_config WHERE id = $1`, [yearId]);
    const yearLabel = yc[0] && yc[0].event_year_label ? yc[0].event_year_label : 'ITS';

    const { rows } = await pool.query(
      `SELECT to_char(vr.collected_at AT TIME ZONE 'Asia/Bahrain', 'YYYY-MM-DD HH24:MI') AS collected_at,
              e.event_code, e.event_name, ag.code AS age_group, ag.sort_order AS ag_sort,
              ca.chest_number, COALESCE(p.full_name, t.team_name) AS name,
              vr.payment_method, vr.amount, vr.recorded,
              cu.full_name AS collected_by, ru.full_name AS recorded_by
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
        ORDER BY e.event_code, ag.sort_order NULLS LAST, ca.chest_number NULLS LAST, name`, [yearId]);

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); wb.creator = 'KCA ITS'; wb.created = new Date();
    const ws = wb.addWorksheet('Collections');
    ws.columns = [
      { header: 'Event', key: 'event', width: 30 },
      { header: 'Age Group', key: 'ag', width: 11 },
      { header: 'Chest', key: 'chest', width: 8 },
      { header: 'Participant', key: 'name', width: 26 },
      { header: 'Method', key: 'method', width: 12 },
      { header: 'Amount (BD)', key: 'amount', width: 12 },
      { header: 'Recorded', key: 'recorded', width: 10 },
      { header: 'Collected by', key: 'collected_by', width: 20 },
      { header: 'Collected at', key: 'collected_at', width: 18 },
      { header: 'Recorded by', key: 'recorded_by', width: 20 },
    ];
    ws.getColumn('amount').numFmt = '0.000';
    let total = 0, cash = 0, bp = 0;
    rows.forEach((r) => {
      const amt = Number(r.amount || 0); total += amt;
      if (r.payment_method === 'benefitpay') bp += amt; else cash += amt;
      ws.addRow({
        event: `${r.event_code || ''} ${r.event_name || ''}`.trim(), ag: r.age_group || '',
        chest: r.chest_number ?? '', name: String(r.name || '').toUpperCase(),
        method: r.payment_method === 'benefitpay' ? 'BenefitPay' : 'Cash', amount: amt,
        recorded: r.recorded ? 'Yes' : 'No', collected_by: r.collected_by || '',
        collected_at: r.collected_at || '', recorded_by: r.recorded_by || '',
      });
    });
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: 'A1', to: 'J1' };
    const r3 = (n) => Math.round(n * 1000) / 1000;
    const totRow = ws.addRow({ name: 'TOTAL', amount: r3(total) }); totRow.font = { bold: true };

    const sm = wb.addWorksheet('Summary');
    sm.columns = [{ header: 'Item', key: 'k', width: 22 }, { header: 'Value', key: 'v', width: 14 }];
    sm.getColumn('v').numFmt = '0.000';
    [['Total videos', rows.length], ['Cash (BD)', r3(cash)], ['BenefitPay (BD)', r3(bp)], ['Total (BD)', r3(cash + bp)]]
      .forEach(([k, v]) => sm.addRow({ k, v }));
    sm.getRow(1).font = { bold: true };

    const buf = await wb.xlsx.writeBuffer();
    const label = String(yearLabel).replace(/[^A-Za-z0-9]+/g, '-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="video-collections-${label}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) { next(err); }
});

module.exports = router;

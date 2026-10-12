// src/routes/admin.lists.routes.js  (mounted at /api/admin/lists)
//
// Post-registration lists (Blueprint: initial list publication + final list):
//   GET  /by-event        — events with their participants (for event-wise
//                           printed lists, grouped by age group)
//   GET  /by-participant  — participants with their events (distributed to
//                           each registered participant for confirmation)
//   GET  /final           — final roster of participants + totals
//   POST /publish-initial — stamps year_config.initial_list_published
//
// DB-verified columns: registrations(status enum, participant_id, event_id,
// age_group_id), participants(full_name, cpr_number, school_id, created_by,
// admin_verified_status), year_config(initial_list_published[_at]).

const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const { fetchImageBuffer } = require('../utils/pdf');

/** Absolute URL for an app-served (relative) logo path, so pdfkit can fetch it. */
function absUrl(u) {
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  const base = (process.env.APP_URL || 'https://talentscan.kcabah.com').replace(/\/+$/, '');
  return `${base}${u.startsWith('/') ? '' : '/'}${u}`;
}

/** Render ONE age-group's initial list to a PDF Buffer (events A-Z, names A-Z). */
function renderGroupPdf({ kcaLogo, sponsorLogo, year, group }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const top = doc.y;
    if (kcaLogo) { try { doc.image(kcaLogo, 40, top, { width: 64 }); } catch { /* ignore */ } }
    if (sponsorLogo) { try { doc.image(sponsorLogo, doc.page.width - 104, top, { width: 64 }); } catch { /* ignore */ } }
    doc.fontSize(15).fillColor('#1e3a5f').text(year?.event_year_label || 'KCA Indian Talent Scan', 0, top, { align: 'center' });
    doc.moveDown(0.3).fontSize(13).fillColor('#1e3a5f')
      .text(`Initial List — ${group.label ? group.label + ' (' + group.code + ')' : group.code}`, { align: 'center' });
    doc.moveDown(0.1).fontSize(9).fillColor('#64748b')
      .text(`As registered · printed ${new Date().toLocaleString('en-GB')}`, { align: 'center' });
    doc.moveDown(1);

    const eventNames = [...group.events.keys()].sort((a, b) => a.localeCompare(b));
    if (eventNames.length === 0) {
      doc.fontSize(11).fillColor('#64748b').text('No entries in this age group.');
    }
    for (const evName of eventNames) {
      const ev = group.events.get(evName);
      const names = [...ev.names].sort((a, b) => a.localeCompare(b));
      if (doc.y > doc.page.height - 120) doc.addPage();
      doc.moveDown(0.6);
      doc.fontSize(12).fillColor('#1e3a5f').text(evName, { continued: true })
        .fontSize(9).fillColor('#64748b')
        .text(`   (${ev.code}) · ${names.length} entr${names.length === 1 ? 'y' : 'ies'}`);
      doc.moveDown(0.2);
      doc.fontSize(10.5).fillColor('#1e293b');
      names.forEach((n, i) => {
        if (doc.y > doc.page.height - 50) doc.addPage();
        doc.text(`${i + 1}.  ${n}`, { indent: 12 });
      });
    }
    doc.end();
  });
}

const router = express.Router();
router.use(authenticate);

const staffRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman'];

async function activeYear() {
  const { rows } = await pool.query(
    `SELECT id, event_year_label, kca_logo_url, its_logo_url, sponsor_logo_url, sponsor_name,
            initial_list_published, initial_list_published_at
     FROM year_config WHERE is_active = TRUE LIMIT 1`);
  return rows[0] || null;
}

// ── GET /api/admin/lists/by-event ─────────────────────────────────────────────
router.get('/by-event', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });

    const { rows } = await pool.query(
      `SELECT e.id AS event_id, e.event_code, e.event_name, e.event_kind,
              c.name AS category_name,
              ag.code AS age_group_code, ag.label AS age_group_label,
              p.id AS participant_id, p.full_name, p.cpr_number,
              t.team_name, s.name AS school_name
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       LEFT JOIN categories c ON c.id = e.category_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       LEFT JOIN participants p ON p.id = r.participant_id
       LEFT JOIN teams t ON t.id = r.team_id
       LEFT JOIN schools s ON s.id = p.school_id
       WHERE r.year_id = $1 AND r.status NOT IN ('withdrawn','swapped')
         AND e.is_cancelled = FALSE
         AND (p.confirmed_at IS NOT NULL OR r.team_id IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM event_consolidations x WHERE x.kind = 'cancel' AND x.reverted_at IS NULL AND x.source_event_ids[1] = r.event_id AND x.age_group_id = r.age_group_id)
       ORDER BY c.sort_order NULLS LAST, e.event_code, ag.sort_order, p.full_name`,
      [yc.id]);

    // shape: events[] each with entries[] (participant or team)
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.event_id)) {
        map.set(r.event_id, {
          event_id: r.event_id, event_code: r.event_code, event_name: r.event_name,
          event_kind: r.event_kind, category_name: r.category_name, entries: [],
        });
      }
      map.get(r.event_id).entries.push({
        name: r.full_name || `${r.team_name} (team)`,
        cpr_number: r.cpr_number,
        school_name: r.school_name,
        age_group_code: r.age_group_code,
        age_group_label: r.age_group_label,
      });
    }
    res.json({ year: yc, events: [...map.values()] });
  } catch (err) { next(err); }
});

// ── GET /api/admin/lists/by-participant ──────────────────────────────────────
router.get('/by-participant', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });

    const { rows } = await pool.query(
      `SELECT p.id, p.full_name, p.cpr_number, p.admin_verified_status,
              ag.code AS age_group_code, ag.label AS age_group_label,
              s.name AS school_name,
              u.full_name AS parent_name, COALESCE(u.whatsapp_number, u.phone) AS parent_contact,
              e.event_code, e.event_name, cat.name AS category_name
       FROM participants p
       LEFT JOIN age_groups ag ON ag.id = p.age_group_id
       LEFT JOIN schools s ON s.id = p.school_id
       LEFT JOIN users u ON u.id = p.created_by
       JOIN registrations r ON r.participant_id = p.id
         AND r.status NOT IN ('withdrawn','swapped')
       JOIN events e ON e.id = r.event_id AND e.is_cancelled = FALSE
       LEFT JOIN categories cat ON cat.id = e.category_id
       WHERE p.year_id = $1 AND p.confirmed_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM event_consolidations x WHERE x.kind = 'cancel' AND x.reverted_at IS NULL AND x.source_event_ids[1] = r.event_id AND x.age_group_id = r.age_group_id)
       ORDER BY ag.sort_order, p.full_name, e.event_code`,
      [yc.id]);

    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.id)) {
        map.set(r.id, {
          participant_id: r.id, full_name: r.full_name, cpr_number: r.cpr_number,
          age_group_code: r.age_group_code, age_group_label: r.age_group_label,
          school_name: r.school_name, parent_name: r.parent_name,
          parent_contact: r.parent_contact,
          admin_verified_status: r.admin_verified_status,
          events: [],
        });
      }
      map.get(r.id).events.push({
        event_code: r.event_code, event_name: r.event_name, category_name: r.category_name,
      });
    }
    res.json({ year: yc, participants: [...map.values()] });
  } catch (err) { next(err); }
});

// ── GET /api/admin/lists/final ────────────────────────────────────────────────
// Final roster + headline totals (participants, entries, per-group counts).
router.get('/final', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });

    const { rows } = await pool.query(
      `SELECT p.id, p.full_name, p.cpr_number, p.gender,
              ag.code AS age_group_code, s.name AS school_name,
              COUNT(r.id)::int AS event_count,
              string_agg(e.event_code, ', ' ORDER BY e.event_code) AS event_codes,
              json_agg(json_build_object('event_code', e.event_code, 'event_name', e.event_name)
                       ORDER BY e.event_code) AS events
       FROM participants p
       LEFT JOIN age_groups ag ON ag.id = p.age_group_id
       LEFT JOIN schools s ON s.id = p.school_id
       JOIN registrations r ON r.participant_id = p.id
         AND r.status NOT IN ('withdrawn','swapped')
       JOIN events e ON e.id = r.event_id AND e.is_cancelled = FALSE
       WHERE p.year_id = $1 AND p.confirmed_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM event_consolidations x WHERE x.kind = 'cancel' AND x.reverted_at IS NULL AND x.source_event_ids[1] = r.event_id AND x.age_group_id = r.age_group_id)
       GROUP BY p.id, ag.code, ag.sort_order, s.name
       ORDER BY ag.sort_order, p.full_name`,
      [yc.id]);

    const byGroup = {};
    for (const r of rows) byGroup[r.age_group_code || '—'] = (byGroup[r.age_group_code || '—'] || 0) + 1;
    const totals = {
      participants: rows.length,
      entries: rows.reduce((t, r) => t + r.event_count, 0),
      by_group: byGroup,
    };
    res.json({ year: yc, totals, participants: rows });
  } catch (err) { next(err); }
});

// ── POST /api/admin/lists/publish-initial ────────────────────────────────────
router.post('/publish-initial', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE year_config SET initial_list_published = TRUE,
              initial_list_published_at = NOW(), updated_at = NOW()
       WHERE is_active = TRUE
       RETURNING id, initial_list_published, initial_list_published_at`);
    if (!rows[0]) return res.status(400).json({ error: 'No active year' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'PUBLISH_INITIAL_LIST', entity: 'year_config', entityId: rows[0].id,
      reason: 'Initial registration lists published for distribution' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/admin/lists/initial-pdf ──────────────────────────────────────────
// Streams a ZIP containing one PDF per age group — the INITIAL list exactly AS
// REGISTERED (no merge/split/cancel applied): events alphabetical, participant
// names alphabetical. Read-only; generates nothing in the database.
router.get('/initial-pdf', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });

    const { rows } = await pool.query(
      `SELECT ag.id AS ag_id, ag.code AS age_group_code, ag.label AS age_group_label,
              ag.sort_order AS ag_sort,
              e.event_name, e.event_code,
              p.full_name, t.team_name
         FROM registrations r
         JOIN events e ON e.id = r.event_id
         LEFT JOIN age_groups ag ON ag.id = r.age_group_id
         LEFT JOIN participants p ON p.id = r.participant_id
         LEFT JOIN teams t ON t.id = r.team_id
        WHERE r.year_id = $1
          AND r.status NOT IN ('withdrawn','swapped')
          AND e.is_generated = FALSE
          AND (p.confirmed_at IS NOT NULL OR r.team_id IS NOT NULL)
        ORDER BY ag.sort_order NULLS LAST, e.event_name, p.full_name`,
      [yc.id]);

    // group by age-group → event name → names[]
    const groups = new Map(); // ag_id → { code, label, sort, events: Map(name → {code, names[]}) }
    for (const r of rows) {
      const gid = r.ag_id ?? 0;
      if (!groups.has(gid))
        groups.set(gid, { code: r.age_group_code || '—', label: r.age_group_label || '', sort: r.ag_sort ?? 99, events: new Map() });
      const g = groups.get(gid);
      if (!g.events.has(r.event_name)) g.events.set(r.event_name, { code: r.event_code, names: [] });
      g.events.get(r.event_name).names.push(r.full_name || `${r.team_name} (team)`);
    }
    const ordered = [...groups.values()].sort((a, b) => (a.sort - b.sort) || a.code.localeCompare(b.code));
    if (ordered.length === 0) return res.status(400).json({ error: 'No registrations to list yet.' });

    const [kcaLogo, sponsorLogo] = await Promise.all([
      fetchImageBuffer(absUrl(yc.kca_logo_url)),
      fetchImageBuffer(absUrl(yc.sponsor_logo_url)),
    ]);

    const safe = (x) => String(x || '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    const label = safe(yc.event_year_label) || 'ITS';

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="initial-lists-${label}.zip"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => { console.error('initial-pdf zip error:', err.message); try { res.status(500).end(); } catch { /* noop */ } });
    archive.pipe(res);

    const used = new Set();
    for (const g of ordered) {
      const buf = await renderGroupPdf({ kcaLogo, sponsorLogo, year: yc, group: g });
      let name = `${label}_${safe(g.code)}${g.label ? '_' + safe(g.label) : ''}.pdf`;
      let n = 1;
      while (used.has(name)) name = name.replace(/\.pdf$/, `_${++n}.pdf`);
      used.add(name);
      archive.append(buf, { name });
    }

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'EXPORT_INITIAL_LIST_PDF', entity: 'year_config', entityId: yc.id,
      details: { age_groups: ordered.length } });

    await archive.finalize();
  } catch (err) { next(err); }
});

module.exports = router;

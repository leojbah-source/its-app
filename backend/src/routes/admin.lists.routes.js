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
const { prepLogo } = require('../utils/pdf');

const INK = '#1e3a5f', MUTE = '#64748b', BODY = '#1e293b', RED = '#b91c1c';

/** Full branded header + age-group banner at the top of a group's first page. */
function drawGroupHeader(doc, logos, year, group) {
  const M = doc.page.margins.left;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const topY = doc.page.margins.top;
  const logoH = 46;
  if (logos.kca)     { try { doc.image(logos.kca, M, topY, { fit: [72, logoH], align: 'left', valign: 'top' }); } catch { /* */ } }
  if (logos.sponsor) { try { doc.image(logos.sponsor, doc.page.width - doc.page.margins.right - 72, topY, { fit: [72, logoH], align: 'right', valign: 'top' }); } catch { /* */ } }
  if (logos.its)     { try { doc.image(logos.its, (doc.page.width / 2) - 26, topY - 2, { fit: [52, logoH + 4] }); } catch { /* */ } }
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(15)
     .text(year.event_year_label || 'KCA Indian Talent Scan', M, topY + logoH + 4, { width: W, align: 'center' });
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTE)
     .text(`Initial List (as registered) · printed ${new Date().toLocaleString('en-GB')}`, { width: W, align: 'center' });
  const by = doc.y + 8;
  doc.roundedRect(M, by, W, 23, 4).fill(INK);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(12)
     .text(`AGE GROUP — ${group.label ? group.label + ' (' + group.code + ')' : group.code}`, M + 10, by + 6, { width: W - 20 });
  doc.font('Helvetica').fillColor(BODY);
  doc.x = M; doc.y = by + 33;
}

/** Slim running header stamped on continuation pages within a group. */
function drawRunningHeader(doc, group) {
  const M = doc.page.margins.left;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const topY = doc.page.margins.top;
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
     .text(`AGE GROUP ${group.code}${group.label ? ' — ' + group.label : ''}  (continued)`, M, topY, { width: W });
  doc.moveTo(M, topY + 15).lineTo(doc.page.width - doc.page.margins.right, topY + 15).strokeColor('#cbd5e1').lineWidth(0.7).stroke();
  doc.font('Helvetica').fillColor(BODY);
  doc.x = M; doc.y = topY + 22;
}

/** Render ONE age group to a PDF Buffer: events A-Z, names A-Z, under-strength
 *  events in red, branded header + banner, running header, page numbers.
 *  Manual pagination (no pageAdded reentrancy) + margin-zero footer so no blank
 *  pages are produced. */
function renderGroupPdf(logos, year, group, minTh) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 45, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const bottom = () => doc.page.height - doc.page.margins.bottom - 16;
    const newPage = () => { doc.addPage(); drawRunningHeader(doc, group); };

    drawGroupHeader(doc, logos, year, group);
    const eventNames = [...group.events.keys()].sort((a, b) => a.localeCompare(b));
    if (eventNames.length === 0) doc.font('Helvetica').fontSize(11).fillColor(MUTE).text('No individual entries in this age group.');

    for (const evName of eventNames) {
      const ev = group.events.get(evName);
      const names = [...ev.names].map((n) => String(n || '').toUpperCase()).sort((a, b) => a.localeCompare(b));
      const under = names.length < minTh;
      if (doc.y + 48 > bottom()) newPage();
      doc.moveDown(0.45);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(under ? RED : INK).text(evName, { continued: true })
         .font('Helvetica').fontSize(9).fillColor(under ? RED : MUTE)
         .text(`   (${ev.code}) · ${names.length} entr${names.length === 1 ? 'y' : 'ies'}${under ? `  — fewer than ${minTh}` : ''}`);
      doc.moveDown(0.15);
      doc.font('Helvetica').fontSize(10.5).fillColor(BODY);
      names.forEach((n, i) => {
        if (doc.y + 15 > bottom()) newPage();
        doc.text(`${i + 1}.  ${n}`, { indent: 14 });
      });
    }

    // Page numbers — zero the bottom margin while writing into it so pdfkit
    // does not auto-append a blank page per footer (known pdfkit footer bug).
    const range = doc.bufferedPageRange();
    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const ob = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(8).fillColor('#94a3b8')
         .text(`Page ${i + 1} of ${range.count}`, doc.page.margins.left, doc.page.height - 30, { width: W, align: 'center', lineBreak: false });
      doc.page.margins.bottom = ob;
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
            COALESCE(min_entries_threshold, 5) AS min_threshold,
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
// Streams a ZIP with one PDF per age group — the INITIAL list exactly AS
// REGISTERED (no merge/split/cancel). INDIVIDUAL events only (team events are
// excluded; their registration is still open). Events A-Z, names A-Z, events
// with fewer than the minimum entries shown in red. Read-only.
router.get('/initial-pdf', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });
    const minTh = Number(yc.min_threshold || 5);

    const { rows } = await pool.query(
      `SELECT ag.id AS ag_id, ag.code AS age_group_code, ag.label AS age_group_label,
              ag.sort_order AS ag_sort, e.event_name, e.event_code, p.full_name
         FROM registrations r
         JOIN events e ON e.id = r.event_id
         LEFT JOIN age_groups ag ON ag.id = r.age_group_id
         JOIN participants p ON p.id = r.participant_id
        WHERE r.year_id = $1
          AND r.status NOT IN ('withdrawn','swapped')
          AND r.team_id IS NULL
          AND e.event_kind = 'individual'
          AND e.is_generated = FALSE
          AND p.confirmed_at IS NOT NULL
        ORDER BY ag.sort_order NULLS LAST, e.event_name, p.full_name`,
      [yc.id]);

    const groups = new Map();
    for (const r of rows) {
      const gid = r.ag_id ?? 0;
      if (!groups.has(gid))
        groups.set(gid, { code: r.age_group_code || '—', label: r.age_group_label || '', sort: r.ag_sort ?? 99, events: new Map() });
      const g = groups.get(gid);
      if (!g.events.has(r.event_name)) g.events.set(r.event_name, { code: r.event_code, names: [] });
      g.events.get(r.event_name).names.push(r.full_name);
    }
    const ordered = [...groups.values()].sort((a, b) => (a.sort - b.sort) || a.code.localeCompare(b.code));
    if (ordered.length === 0) return res.status(400).json({ error: 'No individual registrations to list yet.' });

    const logos = {
      kca: await prepLogo(yc.kca_logo_url),
      its: await prepLogo(yc.its_logo_url),
      sponsor: await prepLogo(yc.sponsor_logo_url),
    };

    const safe = (x) => String(x || '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    const label = safe(yc.event_year_label) || 'ITS';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="initial-lists-${label}.zip"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => { console.error('initial-pdf zip error:', err.message); try { res.status(500).end(); } catch { /* noop */ } });
    archive.pipe(res);

    const used = new Set();
    for (const g of ordered) {
      const buf = await renderGroupPdf(logos, yc, g, minTh);
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

// src/routes/admin.consolidation.routes.js  (mounted at /api/admin/consolidation)
//
// Post-registration consolidation of the entry lists, run per (event × age-group)
// cell after the Initial list is published. Counting unit is one event + one
// age-group of COMPLETED registrations.
//
//   GET  /review          — every cell with its count + status + suggestion
//   GET  /history         — consolidation actions taken (with revert state)
//   POST /merge           — combine a Boys/Girls pair into a "(Common)" event
//   POST /cancel          — mark an under-strength cell cancelled (manual swap/refund)
//   POST /split           — split an over-strength stage cell into 2 events
//   POST /:id/revert      — undo a prior action (moves registrations back)
//   POST /publish-final   — stamp year_config.final_list_published
//
// Every mutating action runs in a transaction, records an event_consolidations
// row with the exact registrations it moved (for a precise revert), writes an
// audit entry, and notifies affected parents by WhatsApp + email. Nothing is
// hard-deleted: reverting moves registrations back and soft-cancels any event
// that was generated.
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { sendWhatsAppImage } = require('../utils/notify');
const { sendEmail } = require('../utils/email');
const PDFDocument = require('pdfkit');
const { fetchImageBuffer, prepLogo } = require('../utils/pdf');

const router = express.Router();
router.use(authenticate);

const VIEW_ROLES  = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman'];
const ACT_ROLES   = ['SuperAdmin', 'Admin', 'Chairman'];
const SPLIT_ROLES = ['SuperAdmin', 'Chairman'];

// ── Helpers ──────────────────────────────────────────────────────────────────
async function activeYear(db = pool) {
  const { rows } = await db.query(
    `SELECT id, event_year_label, its_logo_url, website_domain,
            COALESCE(min_entries_threshold, 5) AS min_threshold,
            COALESCE(split_threshold, 25) AS split_threshold,
            initial_list_published, final_list_published, final_list_published_at
     FROM year_config WHERE is_active = TRUE LIMIT 1`);
  return rows[0] || null;
}

/** Strip a trailing gender marker ("– Boys", "- Girls", "(Boys)") → base name. */
function baseName(name) {
  return String(name || '')
    .replace(/\s*[–—-]\s*(boys|girls)\s*$/i, '')
    .replace(/\s*\((boys|girls)\)\s*$/i, '')
    .trim();
}

/** Absolute public URL of the ITS logo, or null. */
function logoUrl(y) {
  if (!y || !y.its_logo_url) return null;
  if (/^https?:\/\//i.test(y.its_logo_url)) return y.its_logo_url;
  // The logo file is served by THIS app, not the KCA website (website_domain),
  // so WhatsApp must fetch it from the app's own public URL.
  const base = (process.env.APP_URL || 'https://talentscan.kcabah.com').replace(/\/+$/, '');
  return `${base}${y.its_logo_url.startsWith('/') ? '' : '/'}${y.its_logo_url}`;
}

const contactPhone = (r) => r.guardian_phone || r.whatsapp_number || r.parent_phone || null;

/** Registrations (completed) in one event × age-group, with parent contacts. */
async function cellRegistrations(db, eventId, ageGroupId) {
  const { rows } = await db.query(
    `SELECT r.id AS reg_id, p.id AS participant_id, p.full_name, p.guardian_phone,
            p.gender, p.dob, u.email AS parent_email, u.whatsapp_number,
            u.phone AS parent_phone, u.full_name AS parent_name
       FROM registrations r
       JOIN participants p ON p.id = r.participant_id
       LEFT JOIN users u ON u.id = p.created_by
      WHERE r.event_id = $1 AND r.age_group_id = $2
        AND r.status NOT IN ('withdrawn','swapped')
        AND p.confirmed_at IS NOT NULL
      ORDER BY p.dob, p.full_name`,
    [eventId, ageGroupId]);
  return rows;
}

/** Fire-and-forget parent notifications (WhatsApp image + email), throttled. */
function notifyParents(recipients, { logo, subject, waMessage, html }) {
  (async () => {
    for (const r of recipients) {
      const phone = contactPhone(r);
      try {
        if (phone) {
          const text = typeof waMessage === 'function' ? waMessage(r) : waMessage;
          if (logo) await sendWhatsAppImage(phone, logo, text);
        }
      } catch (e) { console.error('consolidation WA failed:', e.message); }
      try {
        if (r.parent_email) {
          await sendEmail({ to: r.parent_email, subject,
            html: typeof html === 'function' ? html(r) : html });
        }
      } catch (e) { console.error('consolidation email failed:', e.message); }
      await new Promise((res) => setTimeout(res, 900));
    }
  })().catch((e) => console.error('notifyParents loop:', e.message));
}

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const round3 = (x) => Math.round(Number(x || 0) * 1000) / 1000;
function eventFee(ev, memberActive) {
  const std = Number(ev.fee_amount || 0);
  if (!memberActive) return round3(std);
  return round3(ev.member_fee_amount != null ? Number(ev.member_fee_amount) : std);
}
function genderEligible(genderSplit, g) {
  if (genderSplit === 'boys')  return g === 'M';
  if (genderSplit === 'girls') return g === 'F';
  return true;
}
async function memberActive(db, userId) {
  if (!userId) return false;
  const { rows } = await db.query(`SELECT membership_status FROM users WHERE id = $1`, [userId]);
  return rows[0]?.membership_status === 'active';
}
/** True if regId belongs to a non-reverted CANCEL consolidation in this year. */
async function isAffectedCancelReg(db, yearId, regId) {
  const { rows } = await db.query(
    `SELECT 1 FROM event_consolidations ec
       CROSS JOIN LATERAL jsonb_to_recordset(ec.moved) AS m(reg_id int, from_event_id int, to_event_id int)
      WHERE ec.year_id = $1 AND ec.kind = 'cancel' AND ec.reverted_at IS NULL AND m.reg_id = $2
      LIMIT 1`, [yearId, regId]);
  return !!rows[0];
}
function emailShell(inner) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#0f172a;line-height:1.6">${inner}<p style="margin-top:18px">Warm regards,<br>KCA Indian Talent Scan Team</p></div>`;
}

/** A fresh, unique event_code within the active year. */
async function uniqueCode(db, yearId, wanted) {
  let code = wanted, n = 1;
  /* eslint-disable no-await-in-loop */
  while (true) {
    const { rows } = await db.query(
      `SELECT 1 FROM events WHERE year_id = $1 AND event_code = $2 LIMIT 1`, [yearId, code]);
    if (!rows[0]) return code;
    n += 1; code = `${wanted}${n}`;
  }
}

/** Create a generated event by copying settings + criteria from a template event. */
async function createGeneratedEvent(db, yearId, templateId, { code, name, gender_split, origin_note }) {
  const { rows: t } = await db.query(`SELECT * FROM events WHERE id = $1`, [templateId]);
  const e = t[0];
  const finalCode = await uniqueCode(db, yearId, code);
  const { rows } = await db.query(
    `INSERT INTO events
       (year_id, category_id, event_code, event_name, event_kind, is_stage_event,
        time_slot_mode, fee_amount, member_fee_amount, gender_split,
        allotted_time_seconds, grace_period_seconds, yellow_alert_seconds,
        preferred_venue_id, keep_groups_together, requires_tables,
        is_generated, origin_note, sort_order, created_at, updated_at)
     SELECT year_id, category_id, $2, $3, event_kind, is_stage_event,
            time_slot_mode, fee_amount, member_fee_amount, $4,
            allotted_time_seconds, grace_period_seconds, yellow_alert_seconds,
            preferred_venue_id, keep_groups_together, requires_tables,
            TRUE, $5, sort_order, NOW(), NOW()
       FROM events WHERE id = $1
     RETURNING *`,
    [templateId, finalCode, name, gender_split, origin_note]);
  const newId = rows[0].id;
  // Copy scoring criteria (sum stays 100, ≤6 — safe under trg_event_criteria_check).
  await db.query(
    `INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
     SELECT $1, criterion_name, max_score, sequence_order FROM event_criteria WHERE event_id = $2`,
    [newId, templateId]);
  void e;
  return rows[0];
}

async function ensureAgeGroup(db, eventId, ageGroupId) {
  await db.query(
    `INSERT INTO event_age_groups (event_id, age_group_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`, [eventId, ageGroupId]);
}

// ── GET /review ──────────────────────────────────────────────────────────────
router.get('/review', requireRole(...VIEW_ROLES), async (req, res, next) => {
  try {
    const y = await activeYear();
    if (!y) return res.status(400).json({ error: 'No active year' });

    const { rows } = await pool.query(
      `SELECT e.id AS event_id, e.event_code, e.event_name, e.gender_split,
              e.is_stage_event, e.is_generated, e.category_id,
              c.name AS category_name, c.sort_order AS cat_sort,
              ag.id AS age_group_id, ag.code AS age_group_code,
              ag.label AS age_group_label, ag.sort_order AS ag_sort,
              COUNT(r.id)::int AS cnt,
              COUNT(r.id) FILTER (WHERE p.gender = 'M')::int AS boys_cnt,
              COUNT(r.id) FILTER (WHERE p.gender = 'F')::int AS girls_cnt
         FROM registrations r
         JOIN events e ON e.id = r.event_id AND e.is_cancelled = FALSE
         LEFT JOIN categories c ON c.id = e.category_id
         LEFT JOIN age_groups ag ON ag.id = r.age_group_id
         LEFT JOIN participants p ON p.id = r.participant_id
        WHERE r.year_id = $1
          AND r.status NOT IN ('withdrawn','swapped')
          AND r.team_id IS NULL AND e.event_kind = 'individual'
          AND p.confirmed_at IS NOT NULL
        GROUP BY e.id, e.event_code, e.event_name, e.gender_split, e.is_stage_event,
                 e.is_generated, e.category_id, c.name, c.sort_order,
                 ag.id, ag.code, ag.label, ag.sort_order`,
      [y.id]);

    const { rows: cancelled } = await pool.query(
      `SELECT source_event_ids[1] AS event_id, age_group_id
         FROM event_consolidations
        WHERE year_id = $1 AND kind = 'cancel' AND reverted_at IS NULL`, [y.id]);
    const isCancelled = new Set(cancelled.map((c) => `${c.event_id}:${c.age_group_id}`));

    // index for partner lookup: base|category|age_group → { boys, girls, none... }
    const byKey = new Map();
    for (const c of rows) {
      c.base = baseName(c.event_name);
      const k = `${c.base.toLowerCase()}|${c.category_id}|${c.age_group_id}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(c);
    }

    const cells = rows.map((c) => {
      const key = `${c.event_id}:${c.age_group_id}`;
      let status = 'ok', suggestion = null, partner = null;
      if (isCancelled.has(key)) {
        status = 'cancelled';
      } else if (c.is_stage_event && c.cnt > y.split_threshold) {
        status = 'over'; suggestion = 'split';
      } else if (c.cnt < y.min_threshold) {
        status = 'under';
        if (c.gender_split === 'boys' || c.gender_split === 'girls') {
          const k = `${c.base.toLowerCase()}|${c.category_id}|${c.age_group_id}`;
          const mate = (byKey.get(k) || []).find(
            (o) => o.event_id !== c.event_id &&
              (o.gender_split === 'boys' || o.gender_split === 'girls') &&
              o.gender_split !== c.gender_split);
          if (mate) {
            partner = { event_id: mate.event_id, event_code: mate.event_code,
              event_name: mate.event_name, gender_split: mate.gender_split, cnt: mate.cnt };
            suggestion = (c.cnt + mate.cnt) >= y.min_threshold ? 'merge' : 'cancel';
          } else suggestion = 'cancel';
        } else suggestion = 'cancel';
      }
      return {
        event_id: c.event_id, event_code: c.event_code, event_name: c.event_name,
        base: c.base, gender_split: c.gender_split, is_stage_event: c.is_stage_event,
        is_generated: c.is_generated, category_name: c.category_name, cat_sort: c.cat_sort,
        age_group_id: c.age_group_id, age_group_code: c.age_group_code,
        age_group_label: c.age_group_label, ag_sort: c.ag_sort, ag_label: c.ag_label,
        count: c.cnt, boys_count: c.boys_cnt, girls_count: c.girls_cnt, status, suggestion, partner,
      };
    }).sort((a, b) =>
      (a.cat_sort ?? 99) - (b.cat_sort ?? 99) ||
      (a.event_code || '').localeCompare(b.event_code || '') ||
      (a.ag_sort ?? 99) - (b.ag_sort ?? 99));

    res.json({
      thresholds: { min: y.min_threshold, split: y.split_threshold },
      initial_published: y.initial_list_published,
      final_published: y.final_list_published,
      final_published_at: y.final_list_published_at,
      cells,
    });
  } catch (err) { next(err); }
});

// ── GET /history ─────────────────────────────────────────────────────────────
router.get('/history', requireRole(...VIEW_ROLES), async (req, res, next) => {
  try {
    const y = await activeYear();
    if (!y) return res.json([]);
    const { rows } = await pool.query(
      `SELECT ec.id, ec.kind, ec.source_event_ids, ec.target_event_ids, ec.note,
              ec.created_at, ec.reverted_at, jsonb_array_length(ec.moved) AS moved_count,
              ag.code AS age_group_code, ag.label AS age_group_label,
              u.full_name AS created_by_name, ru.full_name AS reverted_by_name
         FROM event_consolidations ec
         LEFT JOIN age_groups ag ON ag.id = ec.age_group_id
         LEFT JOIN users u ON u.id = ec.created_by
         LEFT JOIN users ru ON ru.id = ec.reverted_by
        WHERE ec.year_id = $1
        ORDER BY ec.created_at DESC`, [y.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /merge  { age_group_id, boys_event_id, girls_event_id } ─────────────
router.post('/merge', requireRole(...ACT_ROLES), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const ageGroupId = Number(req.body.age_group_id);
    const aId = Number(req.body.boys_event_id);
    const bId = Number(req.body.girls_event_id);
    if (!ageGroupId || !aId || !bId || aId === bId)
      return res.status(400).json({ error: 'age_group_id and two distinct events are required' });

    await client.query('BEGIN');
    const y = await activeYear(client);
    const { rows: evs } = await client.query(
      `SELECT id, event_code, event_name, gender_split, category_id, is_cancelled
         FROM events WHERE id = ANY($1)`, [[aId, bId]]);
    if (evs.length !== 2) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found' }); }
    if (evs.some((e) => e.is_cancelled)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'One of the events is cancelled' }); }
    const a = evs.find((e) => e.id === aId), b = evs.find((e) => e.id === bId);
    const base = baseName(a.event_name);

    const regsA = await cellRegistrations(client, aId, ageGroupId);
    const regsB = await cellRegistrations(client, bId, ageGroupId);
    const all = [...regsA, ...regsB];
    if (all.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No completed registrations in this cell to merge' }); }

    // Reuse an existing (non-reverted) common target for this exact pair, else create one.
    let commonId = null;
    const { rows: prior } = await client.query(
      `SELECT target_event_ids FROM event_consolidations
        WHERE year_id = $1 AND kind = 'merge' AND reverted_at IS NULL
          AND source_event_ids @> $2 AND source_event_ids <@ $2
        ORDER BY created_at DESC LIMIT 1`, [y.id, [aId, bId]]);
    if (prior[0] && prior[0].target_event_ids && prior[0].target_event_ids[0]) {
      const cand = prior[0].target_event_ids[0];
      const { rows: c } = await client.query(`SELECT id FROM events WHERE id = $1 AND is_cancelled = FALSE`, [cand]);
      if (c[0]) commonId = c[0].id;
    }
    let common;
    if (commonId) {
      const { rows } = await client.query(`SELECT * FROM events WHERE id = $1`, [commonId]);
      common = rows[0];
    } else {
      common = await createGeneratedEvent(client, y.id, aId, {
        code: `${a.event_code}C`,
        name: `${base} (Common)`,
        gender_split: 'common',
        origin_note: `Merged from ${a.event_code}+${b.event_code}`,
      });
      commonId = common.id;
    }
    await ensureAgeGroup(client, commonId, ageGroupId);

    const moved = all.map((r) => ({ reg_id: r.reg_id, from_event_id: (regsA.includes(r) ? aId : bId), to_event_id: commonId }));
    await client.query(
      `UPDATE registrations SET event_id = $1, updated_at = NOW() WHERE id = ANY($2)`,
      [commonId, all.map((r) => r.reg_id)]);

    const note = `${base} — ${a.event_code}(${regsA.length}) + ${b.event_code}(${regsB.length}) → ${common.event_code} [${all.length}]`;
    const { rows: cons } = await client.query(
      `INSERT INTO event_consolidations
         (year_id, kind, source_event_ids, target_event_ids, age_group_id, moved, note, created_by)
       VALUES ($1,'merge',$2,$3,$4,$5,$6,$7) RETURNING id`,
      [y.id, [aId, bId], [commonId], ageGroupId, JSON.stringify(moved), note, req.user.id]);

    await client.query('COMMIT');

    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CONSOLIDATE_MERGE',
      entity: 'events', entityId: commonId, details: { source: [aId, bId], age_group_id: ageGroupId, moved: moved.length }, reason: note });

    // Notify affected parents (unless the admin turned notifications off for this action).
    if (req.body.notify !== false) {
    const logo = logoUrl(y);
    notifyParents(all, {
      logo,
      subject: `Update: ${base} is now a combined event — ${y.event_year_label || 'ITS 2026'}`,
      waMessage: (r) => `Dear ${r.parent_name || 'Parent'},\n\nAn update on ${r.full_name}'s entry for *${base}*. As the boys' and girls' entries in this age group were few, they have been combined into a single event, *${base} (Common)*. Your child's registration has been moved automatically — no action is needed. The date, time and venue will appear in the schedule.\n\nKCA Indian Talent Scan Team`,
      html: (r) => emailShell(`<p>Dear ${esc(r.parent_name || 'Parent')},</p><p>An update on <b>${esc(r.full_name)}</b>'s entry for <b>${esc(base)}</b>. As the boys' and girls' entries in this age group were few, they have been combined into a single event, <b>${esc(base)} (Common)</b>. Your child's registration has been moved automatically — no action is needed.</p>`),
    });
    }

    res.json({ ok: true, consolidation_id: cons[0].id, common_event: { id: commonId, event_code: common.event_code, event_name: common.event_name }, moved: all.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── POST /cancel  { event_id, age_group_id, reason? } ────────────────────────
router.post('/cancel', requireRole(...ACT_ROLES), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const eventId = Number(req.body.event_id);
    const ageGroupId = Number(req.body.age_group_id);
    const reason = (req.body.reason || '').trim() || null;
    if (!eventId || !ageGroupId) return res.status(400).json({ error: 'event_id and age_group_id are required' });

    await client.query('BEGIN');
    const y = await activeYear(client);
    const { rows: ev } = await client.query(`SELECT id, event_code, event_name FROM events WHERE id = $1`, [eventId]);
    if (!ev[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found' }); }
    const { rows: dup } = await client.query(
      `SELECT id FROM event_consolidations WHERE year_id=$1 AND kind='cancel' AND reverted_at IS NULL
         AND source_event_ids[1] = $2 AND age_group_id = $3 LIMIT 1`, [y.id, eventId, ageGroupId]);
    if (dup[0]) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This cell is already cancelled' }); }

    const regs = await cellRegistrations(client, eventId, ageGroupId);
    const moved = regs.map((r) => ({ reg_id: r.reg_id, from_event_id: eventId, to_event_id: null }));
    const note = `Cancelled ${ev[0].event_code} (age group cell, ${regs.length} entr${regs.length === 1 ? 'y' : 'ies'})${reason ? ' — ' + reason : ''}`;
    const { rows: cons } = await client.query(
      `INSERT INTO event_consolidations
         (year_id, kind, source_event_ids, target_event_ids, age_group_id, moved, note, created_by)
       VALUES ($1,'cancel',$2,'{}',$3,$4,$5,$6) RETURNING id`,
      [y.id, [eventId], ageGroupId, JSON.stringify(moved), note, req.user.id]);
    await client.query('COMMIT');

    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CONSOLIDATE_CANCEL',
      entity: 'events', entityId: eventId, details: { age_group_id: ageGroupId, affected: regs.length }, reason: note });

    if (req.body.notify !== false) {
    const logo = logoUrl(y);
    const base = ev[0].event_name;
    notifyParents(regs, {
      logo,
      subject: `Important: ${base} will not be held — ${y.event_year_label || 'ITS 2026'}`,
      waMessage: (r) => `Dear ${r.parent_name || 'Parent'},\n\nWe're sorry to inform you that *${base}* in ${r.full_name}'s age group has fewer than the minimum entries and will not be held this year.\n\nYou may choose another eligible event instead, or request a refund of the entry fee. Please reply here or contact us on WhatsApp 3898 4900 and we'll help you with the change or refund.\n\nKCA Indian Talent Scan Team`,
      html: (r) => emailShell(`<p>Dear ${esc(r.parent_name || 'Parent')},</p><p>We're sorry to inform you that <b>${esc(base)}</b> in ${esc(r.full_name)}'s age group has fewer than the minimum entries and will not be held this year.</p><p>You may choose another eligible event instead, or request a refund of the entry fee. Please reply to this email or contact us on WhatsApp 3898 4900 and we'll help you with the change or refund.</p>`),
    });
    }

    res.json({ ok: true, consolidation_id: cons[0].id, affected: regs.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── POST /split  { event_id, age_group_id, mode:'gender'|'age' } ─────────────
router.post('/split', requireRole(...SPLIT_ROLES), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const eventId = Number(req.body.event_id);
    const ageGroupId = Number(req.body.age_group_id);
    const mode = req.body.mode === 'age' ? 'age' : 'gender';
    if (!eventId || !ageGroupId) return res.status(400).json({ error: 'event_id and age_group_id are required' });

    await client.query('BEGIN');
    const y = await activeYear(client);
    const { rows: ev } = await client.query(`SELECT * FROM events WHERE id = $1`, [eventId]);
    if (!ev[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found' }); }
    const src = ev[0];
    const base = baseName(src.event_name);

    const regs = await cellRegistrations(client, eventId, ageGroupId);
    if (regs.length < 2) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Need at least 2 registrations to split' }); }

    let groupA, groupB, aName, bName, aCode, bCode, aGender, bGender, aNote, bNote;
    if (mode === 'gender') {
      groupA = regs.filter((r) => r.gender === 'M');
      groupB = regs.filter((r) => r.gender === 'F');
      if (!groupA.length || !groupB.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Both boys and girls are needed to split by gender' }); }
      aName = `${base} – Boys`; bName = `${base} – Girls`;
      aCode = `${src.event_code}B`; bCode = `${src.event_code}G`;
      aGender = 'boys'; bGender = 'girls';
      aNote = `Split from ${src.event_code} by gender (Boys)`; bNote = `Split from ${src.event_code} by gender (Girls)`;
    } else {
      const sorted = [...regs].sort((r1, r2) => new Date(r1.dob) - new Date(r2.dob)); // oldest first
      const half = Math.ceil(sorted.length / 2);
      groupA = sorted.slice(0, half);  // older group
      groupB = sorted.slice(half);     // younger group
      aName = `${base} – Group A`; bName = `${base} – Group B`;
      aCode = `${src.event_code}A`; bCode = `${src.event_code}B`;
      aGender = src.gender_split; bGender = src.gender_split;
      aNote = `Split from ${src.event_code} by age (A/older)`; bNote = `Split from ${src.event_code} by age (B/younger)`;
    }

    const evA = await createGeneratedEvent(client, y.id, eventId, { code: aCode, name: aName, gender_split: aGender, origin_note: aNote });
    const evB = await createGeneratedEvent(client, y.id, eventId, { code: bCode, name: bName, gender_split: bGender, origin_note: bNote });
    await ensureAgeGroup(client, evA.id, ageGroupId);
    await ensureAgeGroup(client, evB.id, ageGroupId);

    const moved = [
      ...groupA.map((r) => ({ reg_id: r.reg_id, from_event_id: eventId, to_event_id: evA.id })),
      ...groupB.map((r) => ({ reg_id: r.reg_id, from_event_id: eventId, to_event_id: evB.id })),
    ];
    await client.query(`UPDATE registrations SET event_id = $1, updated_at = NOW() WHERE id = ANY($2)`, [evA.id, groupA.map((r) => r.reg_id)]);
    await client.query(`UPDATE registrations SET event_id = $1, updated_at = NOW() WHERE id = ANY($2)`, [evB.id, groupB.map((r) => r.reg_id)]);

    const note = `Split ${src.event_code} by ${mode}: ${evA.event_code}(${groupA.length}) + ${evB.event_code}(${groupB.length})`;
    const { rows: cons } = await client.query(
      `INSERT INTO event_consolidations
         (year_id, kind, source_event_ids, target_event_ids, age_group_id, moved, note, created_by)
       VALUES ($1,'split',$2,$3,$4,$5,$6,$7) RETURNING id`,
      [y.id, [eventId], [evA.id, evB.id], ageGroupId, JSON.stringify(moved), note, req.user.id]);
    await client.query('COMMIT');

    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CONSOLIDATE_SPLIT',
      entity: 'events', entityId: eventId, details: { mode, targets: [evA.id, evB.id], moved: moved.length }, reason: note });

    if (req.body.notify !== false) {
    const logo = logoUrl(y);
    const nameFor = (r) => (groupA.find((g) => g.reg_id === r.reg_id) ? evA.event_name : evB.event_name);
    notifyParents(regs, {
      logo,
      subject: `Update: ${base} has been split — ${y.event_year_label || 'ITS 2026'}`,
      waMessage: (r) => `Dear ${r.parent_name || 'Parent'},\n\nAs *${base}* had a large number of entries, it has been split into groups. ${r.full_name} is now entered in *${nameFor(r)}*. The registration has been moved automatically — no action is needed. The date, time and venue will appear in the schedule.\n\nKCA Indian Talent Scan Team`,
      html: (r) => emailShell(`<p>Dear ${esc(r.parent_name || 'Parent')},</p><p>As <b>${esc(base)}</b> had a large number of entries, it has been split into groups. <b>${esc(r.full_name)}</b> is now entered in <b>${esc(nameFor(r))}</b>. The registration has been moved automatically — no action is needed.</p>`),
    });
    }

    res.json({ ok: true, consolidation_id: cons[0].id, events: [
      { id: evA.id, event_code: evA.event_code, event_name: evA.event_name, count: groupA.length },
      { id: evB.id, event_code: evB.event_code, event_name: evB.event_name, count: groupB.length },
    ] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── POST /:id/revert ─────────────────────────────────────────────────────────
router.post('/:id/revert', requireRole(...ACT_ROLES), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cr } = await client.query(
      `SELECT * FROM event_consolidations WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const c = cr[0];
    if (!c) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Action not found' }); }
    if (c.reverted_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This action was already reverted' }); }

    const moved = Array.isArray(c.moved) ? c.moved : [];
    // Move each registration back to its original event.
    for (const m of moved) {
      if (m.reg_id && m.from_event_id) {
        await client.query(`UPDATE registrations SET event_id = $1, updated_at = NOW() WHERE id = $2`, [m.from_event_id, m.reg_id]);
      }
    }
    // Soft-cancel any generated target event that now has no registrations.
    for (const tid of (c.target_event_ids || [])) {
      const { rows: gen } = await client.query(`SELECT is_generated FROM events WHERE id = $1`, [tid]);
      if (!gen[0] || !gen[0].is_generated) continue;
      const { rows: left } = await client.query(`SELECT COUNT(*)::int AS n FROM registrations WHERE event_id = $1 AND status NOT IN ('withdrawn','swapped')`, [tid]);
      if (left[0].n === 0) {
        await client.query(
          `UPDATE events SET is_cancelled = TRUE, cancelled_at = NOW(), cancel_reason = 'Consolidation reverted', cancelled_by = $2, updated_at = NOW() WHERE id = $1`,
          [tid, req.user.id]);
      }
    }
    await client.query(`UPDATE event_consolidations SET reverted_at = NOW(), reverted_by = $2 WHERE id = $1`, [c.id, req.user.id]);
    await client.query('COMMIT');

    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CONSOLIDATE_REVERT',
      entity: 'event_consolidations', entityId: c.id, details: { kind: c.kind, restored: moved.length }, reason: `Reverted: ${c.note || ''}` });

    res.json({ ok: true, reverted: c.id, restored: moved.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── POST /publish-final ──────────────────────────────────────────────────────
router.post('/publish-final', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE year_config SET final_list_published = TRUE, final_list_published_at = NOW(), updated_at = NOW()
        WHERE is_active = TRUE RETURNING id, final_list_published, final_list_published_at`);
    if (!rows[0]) return res.status(400).json({ error: 'No active year' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'PUBLISH_FINAL_LIST',
      entity: 'year_config', entityId: rows[0].id, reason: 'Final event/participant lists published' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});


// ── Batch notifications ──────────────────────────────────────────────────────
// After all consolidation is done, notify each affected parent ONCE with a
// consolidated message listing only their own child's affected events. Only
// actions that are not reverted and not yet notified are included.

/** Gather pending (unnotified, unreverted) changes grouped by parent. */
async function pendingByParent(db, yearId) {
  const { rows } = await db.query(
    `SELECT ec.id AS cons_id, ec.kind,
            p.full_name AS child, p.created_by AS parent_id, p.guardian_phone,
            u.full_name AS parent_name, u.email AS parent_email,
            u.whatsapp_number, u.phone AS parent_phone,
            fe.event_name AS from_name, te.event_name AS to_name
       FROM event_consolidations ec
       CROSS JOIN LATERAL jsonb_array_elements(ec.moved) AS m
       JOIN registrations r ON r.id = (m->>'reg_id')::int
       JOIN participants p ON p.id = r.participant_id
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN events fe ON fe.id = NULLIF(m->>'from_event_id','')::int
       LEFT JOIN events te ON te.id = NULLIF(m->>'to_event_id','')::int
      WHERE ec.year_id = $1 AND ec.notified_at IS NULL AND ec.reverted_at IS NULL
      ORDER BY p.created_by, p.full_name`, [yearId]);

  const groups = new Map();       // parent_id (or email) -> group
  const consIds = new Set();
  for (const r of rows) {
    consIds.add(r.cons_id);
    const key = r.parent_id != null ? `u${r.parent_id}` : (r.parent_email || `x${r.cons_id}`);
    if (!groups.has(key)) {
      groups.set(key, {
        parent_name: r.parent_name || 'Parent',
        parent_email: r.parent_email || null,
        phone: r.whatsapp_number || r.parent_phone || r.guardian_phone || null,
        items: [],
      });
    }
    groups.get(key).items.push({ child: r.child, kind: r.kind, from_name: r.from_name, to_name: r.to_name });
  }
  return { groups: [...groups.values()], consIds: [...consIds] };
}

function lineFor(it) {
  if (it.kind === 'merge') return `${it.child} — ${it.from_name}: now combined into ${it.to_name}. No action needed.`;
  if (it.kind === 'split') return `${it.child} — ${it.from_name}: now moved to ${it.to_name} (the event was split). No action needed.`;
  return `${it.child} — ${it.from_name}: this event will not be held (too few entries). Please choose another event or request a refund.`;
}

// GET /notifications/pending — how many parents / changes are waiting to be sent
router.get('/notifications/pending', requireRole(...VIEW_ROLES), async (req, res, next) => {
  try {
    const y = await activeYear();
    if (!y) return res.json({ parent_count: 0, change_count: 0, preview: [] });
    const { groups, consIds } = await pendingByParent(pool, y.id);
    const preview = groups.slice(0, 6).map((g) => ({ parent_name: g.parent_name, has_phone: !!g.phone, has_email: !!g.parent_email, lines: g.items.map(lineFor) }));
    res.json({
      parent_count: groups.length,
      change_count: consIds.length,
      preview,
    });
  } catch (err) { next(err); }
});

// POST /notifications/send — send one consolidated WhatsApp + email per parent
router.post('/notifications/send', requireRole(...ACT_ROLES), async (req, res, next) => {
  try {
    const y = await activeYear();
    if (!y) return res.status(400).json({ error: 'No active year' });
    const { groups, consIds } = await pendingByParent(pool, y.id);
    if (consIds.length === 0) return res.json({ ok: true, parents: 0, changes: 0 });

    // Mark included actions notified up-front so a double-click can't re-send.
    await pool.query(
      `UPDATE event_consolidations SET notified_at = NOW(), notified_by = $2
        WHERE id = ANY($1) AND notified_at IS NULL`, [consIds, req.user.id]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CONSOLIDATE_NOTIFY',
      entity: 'event_consolidations', entityId: null, details: { parents: groups.length, changes: consIds.length } });

    const logo = logoUrl(y);
    const label = y.event_year_label || 'ITS 2026';
    // Send in the background (throttled), best-effort.
    (async () => {
      for (const g of groups) {
        const lines = g.items.map(lineFor);
        const wa = `Dear ${g.parent_name},\n\nSome updates to your entries for KCA Indian Talent Scan (ITS) 2026:\n\n${lines.map((l) => '• ' + l).join('\n')}\n\nThe date, time and venue for your events will appear in the schedule. For any change or refund, contact us on WhatsApp 3898 4900.\n\nKCA Indian Talent Scan Team`;
        try { if (g.phone && logo) await sendWhatsAppImage(g.phone, logo, wa); } catch (e) { console.error('notify WA:', e.message); }
        try {
          if (g.parent_email) {
            const html = emailShell(`<p>Dear ${esc(g.parent_name)},</p><p>Some updates to your entries for KCA Indian Talent Scan (ITS) 2026:</p><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p>The date, time and venue for your events will appear in the schedule. For any change or refund, contact us on WhatsApp 3898 4900.</p>`);
            await sendEmail({ to: g.parent_email, subject: `Update on your entries — ${label}`, html });
          }
        } catch (e) { console.error('notify email:', e.message); }
        await new Promise((r) => setTimeout(r, 900));
      }
    })().catch((e) => console.error('notify batch:', e.message));

    res.json({ ok: true, parents: groups.length, changes: consIds.length });
  } catch (err) { next(err); }
});


// ── GET /affected ─────────────────────────────────────────────────────────────
// Every registration hit by a (non-reverted) cancellation, with its resolution
// state, so the office can switch the entry to another event or record a refund.
router.get('/affected', requireRole(...VIEW_ROLES), async (req, res, next) => {
  try {
    const y = await activeYear();
    if (!y) return res.status(400).json({ error: 'No active year' });
    const { rows } = await pool.query(
      `SELECT m.reg_id, ec.age_group_id, ec.source_event_ids[1] AS cancelled_event_id,
              r.status AS reg_status, r.event_id AS reg_event_id, r.fee_amount,
              p.id AS participant_id, p.full_name, p.gender,
              ag.code AS ag_code, ag.label AS ag_label,
              ce.event_code AS cancelled_code, ce.event_name AS cancelled_name,
              u.full_name AS parent_name, COALESCE(u.whatsapp_number, u.phone) AS parent_contact,
              (SELECT COUNT(*)::int FROM refunds rf WHERE rf.registration_id = m.reg_id) AS refund_count,
              act.action AS act_action, act.changed_at AS resolved_at, au.full_name AS resolved_by,
              te.event_code AS to_code, te.event_name AS to_name,
              (act.new_value->>'additional_due')::numeric AS act_add_due,
              (act.new_value->>'new_fee')::numeric        AS act_new_fee,
              COALESCE((act.new_value->>'refund_due')::numeric,
                       (act.new_value->>'refund_amount')::numeric) AS act_refund
         FROM event_consolidations ec
         CROSS JOIN LATERAL jsonb_to_recordset(ec.moved) AS m(reg_id int, from_event_id int, to_event_id int)
         JOIN registrations r ON r.id = m.reg_id
         JOIN participants p ON p.id = r.participant_id
         LEFT JOIN age_groups ag ON ag.id = ec.age_group_id
         LEFT JOIN events ce ON ce.id = ec.source_event_ids[1]
         LEFT JOIN users u ON u.id = p.created_by
         LEFT JOIN LATERAL (
           SELECT al.new_value, al.action, al.changed_by, al.changed_at
             FROM audit_log al
            WHERE al.table_name = 'registrations' AND al.record_id = m.reg_id
              AND al.action IN ('CONSOLIDATE_SWITCH','CONSOLIDATE_REFUND')
            ORDER BY al.id DESC LIMIT 1
         ) act ON TRUE
         LEFT JOIN events te ON te.id = (act.new_value->>'to_event_id')::int
         LEFT JOIN users au ON au.id = act.changed_by
        WHERE ec.year_id = $1 AND ec.kind = 'cancel' AND ec.reverted_at IS NULL
        ORDER BY ag.sort_order NULLS LAST, p.full_name`, [y.id]);

    const items = rows.map((r) => {
      let state = 'open';
      if (r.reg_status === 'withdrawn' && r.refund_count > 0) state = 'refunded';
      else if (r.reg_status === 'swapped') state = 'switched';
      else if (r.reg_status !== 'registered') state = 'closed';
      return {
        reg_id: r.reg_id, participant_id: r.participant_id, full_name: r.full_name, gender: r.gender,
        age_group_id: r.age_group_id, age_group_code: r.ag_code, age_group_label: r.ag_label,
        cancelled_event_id: r.cancelled_event_id, cancelled_code: r.cancelled_code, cancelled_name: r.cancelled_name,
        fee_amount: Number(r.fee_amount || 0),
        parent_name: r.parent_name, parent_contact: r.parent_contact, state,
        to_code: r.to_code || null, to_name: r.to_name || null,
        additional_due: Number(r.act_add_due || 0),
        new_fee: r.act_new_fee != null ? Number(r.act_new_fee) : null,
        refund_amount: Number(r.act_refund || 0),
        resolved_by: r.resolved_by || null, resolved_at: r.resolved_at || null,
      };
    });
    const summary = { total: items.length, open: items.filter((i) => i.state === 'open').length,
      switched: items.filter((i) => i.state === 'switched').length,
      refunded: items.filter((i) => i.state === 'refunded').length };
    res.json({ summary, items });
  } catch (err) { next(err); }
});

// ── GET /affected/:regId/options ──────────────────────────────────────────────
// Eligible events this child could be switched into (same age group, individual,
// not cancelled, gender-eligible, not already entered), with the net fee.
router.get('/affected/:regId/options', requireRole(...VIEW_ROLES), async (req, res, next) => {
  try {
    const y = await activeYear();
    if (!y) return res.status(400).json({ error: 'No active year' });
    const regId = Number(req.params.regId);
    const { rows: rr } = await pool.query(
      `SELECT r.id, r.age_group_id, r.event_id, p.id AS participant_id, p.gender, p.created_by
         FROM registrations r JOIN participants p ON p.id = r.participant_id WHERE r.id = $1`, [regId]);
    const info = rr[0];
    if (!info) return res.status(404).json({ error: 'Registration not found' });
    const mem = await memberActive(pool, info.created_by);

    const { rows: evs } = await pool.query(
      `SELECT e.id, e.event_code, e.event_name, e.fee_amount, e.member_fee_amount, e.gender_split,
              c.name AS category_name
         FROM events e
         JOIN event_age_groups eag ON eag.event_id = e.id AND eag.age_group_id = $2
         LEFT JOIN categories c ON c.id = e.category_id
        WHERE e.year_id = $1 AND e.event_kind = 'individual'
          AND e.is_cancelled = FALSE
          AND e.id <> $3
          -- Exclude any event whose cell for this age group has been consolidated
          -- away: cancelled cells, and the ORIGINAL events of a merge or split
          -- (their registrations now live in the generated Common / A / B event,
          -- which IS offered below). Generated targets are intentionally included.
          AND NOT EXISTS (SELECT 1 FROM event_consolidations x
                           WHERE x.kind IN ('cancel','merge','split') AND x.reverted_at IS NULL
                             AND e.id = ANY(x.source_event_ids) AND x.age_group_id = $2)
          AND NOT EXISTS (SELECT 1 FROM registrations r2 WHERE r2.participant_id = $4
                           AND r2.event_id = e.id AND r2.status NOT IN ('withdrawn','swapped'))
        ORDER BY c.sort_order NULLS LAST, e.event_name`,
      [y.id, info.age_group_id, info.event_id, info.participant_id]);

    const options = evs
      .filter((e) => genderEligible(e.gender_split, info.gender))
      .map((e) => ({ event_id: e.id, event_code: e.event_code, event_name: e.event_name,
        category_name: e.category_name, fee: eventFee(e, mem) }));
    res.json({ options, member_active: mem });
  } catch (err) { next(err); }
});

// ── POST /affected/:regId/switch  { new_event_id } ────────────────────────────
// Move ONLY this cancelled entry to another eligible event. Fee difference is
// auto-handled: more → extra shows in the balance; less → a pending refund of
// the difference. All other events of the child are untouched.
router.post('/affected/:regId/switch', requireRole(...ACT_ROLES), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const regId = Number(req.params.regId);
    const newEventId = Number(req.body.new_event_id);
    if (!regId || !newEventId) return res.status(400).json({ error: 'new_event_id is required' });

    await client.query('BEGIN');
    const y = await activeYear(client);
    if (!(await isAffectedCancelReg(client, y.id, regId))) {
      await client.query('ROLLBACK'); return res.status(400).json({ error: 'This entry is not part of a cancelled event.' });
    }
    const { rows: rr } = await client.query(
      `SELECT r.*, p.gender, p.created_by, p.full_name, p.age_group_id AS p_age
         FROM registrations r JOIN participants p ON p.id = r.participant_id
        WHERE r.id = $1 FOR UPDATE OF r`, [regId]);
    const reg = rr[0];
    if (!reg) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Registration not found' }); }
    if (reg.status !== 'registered') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This entry has already been resolved.' }); }

    const { rows: ne } = await client.query(
      `SELECT e.id, e.category_id, e.event_code, e.event_name, e.fee_amount, e.member_fee_amount, e.gender_split
         FROM events e JOIN event_age_groups eag ON eag.event_id = e.id AND eag.age_group_id = $2
        WHERE e.id = $1 AND e.event_kind = 'individual' AND e.is_cancelled = FALSE`,
      [newEventId, reg.age_group_id]);
    const nev = ne[0];
    if (!nev) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Chosen event is not available for this age group.' }); }
    if (!genderEligible(nev.gender_split, reg.gender)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: reg.gender ? 'Chosen event is restricted to the other gender.' : `We don't have ${reg.full_name}'s gender on record — set it first, then switch.` });
    }
    const { rows: dupe } = await client.query(
      `SELECT id, status FROM registrations WHERE participant_id = $1 AND event_id = $2`, [reg.participant_id, newEventId]);
    if (dupe[0] && dupe[0].status !== 'withdrawn') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'The child is already entered in that event.' }); }

    const mem = await memberActive(client, reg.created_by);
    const oldFee = Number(reg.fee_amount || 0);
    const newFee = eventFee(nev, mem);
    const diff = round3(newFee - oldFee);

    // Retire the cancelled entry.
    await client.query(`UPDATE registrations SET status = 'swapped', updated_at = NOW() WHERE id = $1`, [regId]);

    // Create / reactivate the new entry.
    let newReg;
    if (dupe[0]) {
      ({ rows: [newReg] } = await client.query(
        `UPDATE registrations SET status='registered', fee_amount=$1, age_group_id=$2, category_id=$3,
            registered_by=$4, updated_at=NOW() WHERE id=$5 RETURNING *`,
        [newFee, reg.age_group_id, nev.category_id, req.user.id, dupe[0].id]));
    } else {
      ({ rows: [newReg] } = await client.query(
        `INSERT INTO registrations (year_id, participant_id, event_id, age_group_id, category_id,
            fee_amount, status, registered_by, registered_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'registered',$7,NOW(),NOW()) RETURNING *`,
        [reg.year_id, reg.participant_id, newEventId, reg.age_group_id, nev.category_id, newFee, req.user.id]));
    }

    // Auto refund the difference when the new event is cheaper.
    let refundDue = 0;
    if (diff < 0) {
      refundDue = round3(-diff);
      await client.query(
        `INSERT INTO refunds (year_id, participant_id, registration_id, events_withdrawn, reason,
            original_amount, refund_amount, status, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
        [reg.year_id, reg.participant_id, regId,
         `${reg.event_code || ''}`.trim() || `event #${reg.event_id}`,
         `Fee difference after switching cancelled event to ${nev.event_code} — ${nev.event_name}`,
         oldFee, refundDue, req.user.id]);
    }

    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CONSOLIDATE_SWITCH',
      entity: 'registrations', entityId: regId,
      details: { participant_id: reg.participant_id, from_event_id: reg.event_id, to_event_id: newEventId,
                 old_fee: oldFee, new_fee: newFee, additional_due: diff > 0 ? diff : 0, refund_due: refundDue } });

    res.json({ ok: true, new_event: { id: nev.id, event_code: nev.event_code, event_name: nev.event_name },
      additional_due: diff > 0 ? diff : 0, refund_due: refundDue });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── POST /affected/:regId/refund  { reason? } ─────────────────────────────────
// Withdraw ONLY this cancelled entry and raise a pending refund of its fee.
router.post('/affected/:regId/refund', requireRole(...ACT_ROLES), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const regId = Number(req.params.regId);
    const reason = (req.body.reason || '').trim() || 'Event cancelled — refund requested';
    await client.query('BEGIN');
    const y = await activeYear(client);
    if (!(await isAffectedCancelReg(client, y.id, regId))) {
      await client.query('ROLLBACK'); return res.status(400).json({ error: 'This entry is not part of a cancelled event.' }); }
    const { rows: rr } = await client.query(
      `SELECT r.*, e.event_code, e.event_name FROM registrations r
         LEFT JOIN events e ON e.id = r.event_id WHERE r.id = $1 FOR UPDATE OF r`, [regId]);
    const reg = rr[0];
    if (!reg) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Registration not found' }); }
    if (reg.status !== 'registered') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This entry has already been resolved.' }); }

    await client.query(`UPDATE registrations SET status = 'withdrawn', updated_at = NOW() WHERE id = $1`, [regId]);
    await client.query(
      `INSERT INTO refunds (year_id, participant_id, registration_id, events_withdrawn, reason,
          original_amount, refund_amount, status, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
      [reg.year_id, reg.participant_id, regId,
       `${reg.event_code || ''} — ${reg.event_name || ''}`.trim(), reason,
       Number(reg.fee_amount || 0), Number(reg.fee_amount || 0), req.user.id]);

    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CONSOLIDATE_REFUND',
      entity: 'registrations', entityId: regId,
      details: { participant_id: reg.participant_id, event_id: reg.event_id, refund_amount: Number(reg.fee_amount || 0) }, reason });

    res.json({ ok: true, refund_amount: Number(reg.fee_amount || 0) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// Shared computation for the Changes & Cancellations outputs (PDF and Word):
// which INDIVIDUAL events are at risk of cancellation (under the minimum, not a
// viable merge), which are being combined (Boys+Girls merge), and any splits.
// Mirrors the Consolidation review logic. Returns null if there is no active year.
async function computeChangeLists() {
  const y = await activeYear();
  if (!y) return null;
  const min = Number(y.min_threshold || 5), split = Number(y.split_threshold || 25);
  const { rows: yr } = await pool.query(
    `SELECT event_year_label, kca_logo_url, its_logo_url, sponsor_logo_url FROM year_config WHERE id = $1`, [y.id]);
  const yc = yr[0] || {};
  const { rows: cells } = await pool.query(
    `SELECT e.id AS event_id, e.event_code, e.event_name, e.gender_split, e.is_stage_event, e.category_id,
            ag.id AS ag_id, ag.code AS ag_code, ag.label AS ag_label, ag.sort_order AS ag_sort,
            COUNT(r.id)::int AS count
       FROM registrations r
       JOIN events e ON e.id = r.event_id AND e.is_cancelled = FALSE AND e.is_generated = FALSE
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       LEFT JOIN participants p ON p.id = r.participant_id
      WHERE r.year_id = $1 AND r.status NOT IN ('withdrawn','swapped')
        AND r.team_id IS NULL AND e.event_kind = 'individual'
        AND p.confirmed_at IS NOT NULL
      GROUP BY e.id, e.event_code, e.event_name, e.gender_split, e.is_stage_event, e.category_id,
               ag.id, ag.code, ag.label, ag.sort_order`, [y.id]);
  const { rows: cons } = await pool.query(
    `SELECT ec.kind, ec.source_event_ids, ec.target_event_ids, ec.moved, ec.age_group_id,
            ag.code AS ag_code, ag.label AS ag_label, ag.sort_order AS ag_sort
       FROM event_consolidations ec LEFT JOIN age_groups ag ON ag.id = ec.age_group_id
      WHERE ec.year_id = $1 AND ec.reverted_at IS NULL AND ec.kind IN ('cancel','merge','split')`, [y.id]);
  const ids = new Set();
  cons.forEach((c) => { (c.source_event_ids||[]).forEach((i)=>ids.add(i)); (c.target_event_ids||[]).forEach((i)=>ids.add(i)); });
  const nameById = new Map();
  if (ids.size) { const { rows: evs } = await pool.query(`SELECT id, event_code, event_name FROM events WHERE id = ANY($1)`, [[...ids]]); evs.forEach((e)=>nameById.set(e.id, e)); }
  const nm = (id) => { const e = nameById.get(id); return e ? `${e.event_name} (${e.event_code})` : `#${id}`; };
  const cnt = (c) => Array.isArray(c.moved) ? c.moved.length : 0;
  const byKey = new Map();
  for (const c of cells) { c.base = baseName(c.event_name); const k = `${c.base.toLowerCase()}|${c.category_id}|${c.ag_id}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(c); }
  const cancelled = [], merged = [], splits = [];
  const executedCancel = new Set(), executedMerge = new Set();
  for (const c of cons) {
    if (c.kind === 'cancel') { executedCancel.add(`${c.source_event_ids[0]}:${c.age_group_id}`);
      cancelled.push({ ag_code: c.ag_code, ag_sort: c.ag_sort, ag_label: c.ag_label, label: nm(c.source_event_ids[0]), count: cnt(c), done: true }); }
    else if (c.kind === 'merge') { (c.source_event_ids||[]).forEach((i)=>executedMerge.add(`${i}:${c.age_group_id}`));
      merged.push({ ag_code: c.ag_code, ag_sort: c.ag_sort, ag_label: c.ag_label, src: (c.source_event_ids||[]).map(nm).join(' + '), tgt: (c.target_event_ids&&c.target_event_ids[0]) ? nm(c.target_event_ids[0]) : '(combined)', count: cnt(c), done: true }); }
    else if (c.kind === 'split') { splits.push({ ag_code: c.ag_code, ag_sort: c.ag_sort, ag_label: c.ag_label, src: nm(c.source_event_ids[0]), tgt: (c.target_event_ids||[]).map(nm).join(' + '), done: true }); }
  }
  const seenPair = new Set();
  for (const c of cells) {
    const key = `${c.event_id}:${c.ag_id}`;
    if (executedCancel.has(key) || executedMerge.has(key)) continue;
    if (c.is_stage_event && c.count > split) { splits.push({ ag_code: c.ag_code, ag_sort: c.ag_sort, ag_label: c.ag_label, src: `${c.event_name} (${c.event_code})`, tgt: 'two groups', count: c.count, done: false }); continue; }
    if (c.count < min) {
      let partner = null;
      if (c.gender_split === 'boys' || c.gender_split === 'girls') {
        const k = `${c.base.toLowerCase()}|${c.category_id}|${c.ag_id}`;
        partner = (byKey.get(k)||[]).find((o)=>o.event_id!==c.event_id && (o.gender_split==='boys'||o.gender_split==='girls') && o.gender_split!==c.gender_split);
      }
      if (partner && (c.count + partner.count) >= min) {
        const pk = [c.event_id, partner.event_id].sort((a,b)=>a-b).join('-') + ':' + c.ag_id;
        if (seenPair.has(pk)) continue; seenPair.add(pk);
        merged.push({ ag_code: c.ag_code, ag_sort: c.ag_sort, ag_label: c.ag_label, src: `${c.event_name} (${c.event_code}) + ${partner.event_name} (${partner.event_code})`, tgt: `${c.base} (Common)`, count: c.count + partner.count, done: false });
      } else {
        cancelled.push({ ag_code: c.ag_code, ag_sort: c.ag_sort, ag_label: c.ag_label, label: `${c.event_name} (${c.event_code})`, count: c.count, done: false });
      }
    }
  }
  const byCount = (a, b) => (a.ag_sort ?? 99) - (b.ag_sort ?? 99) || (a.count ?? 0) - (b.count ?? 0) || String(a.label || a.src).localeCompare(String(b.label || b.src));
  cancelled.sort(byCount); merged.sort(byCount); splits.sort(byCount);
  return { min, yc, cancelled, merged, splits };
}

// ── GET /changes-docx ─────────────────────────────────────────────────────────
// Same content as the Changes & Cancellations PDF, as an editable Word (.docx)
// so it can be merged into the parent notice. Read-only.
router.get('/changes-docx', requireRole(...VIEW_ROLES), async (req, res, next) => {
  try {
    const data = await computeChangeLists();
    if (!data) return res.status(400).json({ error: 'No active year' });
    const { min, yc, cancelled, merged, splits } = data;
    const D = require('docx');
    const { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle } = D;
    const FONT = 'Calibri', NAVY = '1E3A5F', RED = 'B91C1C', MUTE = '555555', VIOLET = '7C3AED';

    const title = (txt, o={}) => new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: o.after ?? 40 }, children: [new TextRun({ text: txt, bold: true, color: o.color ?? NAVY, size: o.size ?? 28, font: FONT })] });
    const section = (txt, color) => new Paragraph({ spacing: { before: 220, after: 80 }, border: { bottom: { color: 'E2E8F0', style: BorderStyle.SINGLE, size: 4, space: 2 } }, children: [new TextRun({ text: txt, bold: true, color, size: 25, font: FONT })] });
    const grpHead = (txt) => new Paragraph({ spacing: { before: 120, after: 40 }, children: [new TextRun({ text: txt, bold: true, color: '0F172A', size: 21, font: FONT })] });
    const item = (n, txt) => new Paragraph({ spacing: { after: 30 }, indent: { left: 360 }, children: [new TextRun({ text: `${n}.  ${txt}`, size: 21, font: FONT })] });
    const note = (txt) => new Paragraph({ spacing: { before: 60, after: 60 }, indent: { left: 200 }, children: [new TextRun({ text: txt, italics: true, color: MUTE, size: 18, font: FONT })] });

    const groupLabel = (it) => it.ag_label ? `${it.ag_label} (${it.ag_code})` : (it.ag_code || '—');
    function renderGrouped(items, fmt) {
      const out = [];
      if (!items.length) { out.push(item('', 'None.')); return out; }
      let curAg = null, n = 0;
      for (const it of items) {
        const ag = groupLabel(it);
        if (ag !== curAg) { curAg = ag; n = 0; out.push(grpHead(ag)); }
        n += 1; out.push(item(n, fmt(it)));
      }
      return out;
    }

    const children = [
      title(yc.event_year_label || 'KCA Indian Talent Scan', { size: 30 }),
      title('Changes & Cancellations', { size: 24, color: NAVY, after: 20 }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [new TextRun({ text: `Prepared ${new Date().toLocaleString('en-GB')}`, color: MUTE, size: 18, font: FONT })] }),

      section(`Events with fewer than ${min} entries — at risk of cancellation`, RED),
      ...renderGrouped(cancelled, (c) => `${c.label}  ·  ${c.count} entr${c.count === 1 ? 'y' : 'ies'}${c.done ? '  (cancelled)' : ''}`),
      note(`Listed smallest first within each age group. A child entered in any of these events may switch to ANY other event they are eligible for — not only the events in this list. Choosing an event that is just short of the minimum (for example one with ${min - 2} or ${min - 1} entries) can lift it to ${min} and keep it running. Alternatively, the entry fee can be refunded. To make a change, please contact the KCA office.`),

      section('Events being combined (Boys + Girls merged)', NAVY),
      ...renderGrouped(merged, (c) => `${c.src}  ->  ${c.tgt}  ·  ${c.count} entries${c.done ? '  (confirmed)' : ''}`),
      note('No action is needed for combined events — entries move automatically and will appear in the schedule.'),
    ];
    if (splits.length) {
      children.push(section('Events being split (large entries)', VIOLET));
      children.push(...renderGrouped(splits, (c) => `${c.src}  ->  ${c.tgt}${c.count ? `  ·  ${c.count} entries` : ''}${c.done ? '  (confirmed)' : ''}`));
      children.push(note('No action is needed — these are divided into two groups for judging.'));
    }

    const doc = new Document({ styles: { default: { document: { run: { font: FONT, size: 21 } } } },
      sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } }, children }] });
    const buf = await Packer.toBuffer(doc);

    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'EXPORT_CHANGES_DOCX',
      entity: 'event_consolidations', entityId: null, details: { cancelled: cancelled.length, merged: merged.length, splits: splits.length } });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="changes-and-cancellations.docx"');
    res.send(Buffer.from(buf));
  } catch (err) { next(err); }
});

// ── GET /changes-pdf ──────────────────────────────────────────────────────────
// A standalone, branded "Changes & Cancellations" sheet listing EVERY event that
// will be cancelled (fewer than the minimum entries), combined (merged) or split
// — computed from the live counts, plus any already-confirmed actions — to hand
// to parents alongside the initial list. Read-only.
router.get('/changes-pdf', requireRole(...VIEW_ROLES), async (req, res, next) => {
  try {
    const y = await activeYear();
    if (!y) return res.status(400).json({ error: 'No active year' });
    const min = Number(y.min_threshold || 5), split = Number(y.split_threshold || 25);

    const { rows: yr } = await pool.query(
      `SELECT event_year_label, kca_logo_url, its_logo_url, sponsor_logo_url FROM year_config WHERE id = $1`, [y.id]);
    const yc = yr[0] || {};
    const logos = { kca: await prepLogo(yc.kca_logo_url), its: await prepLogo(yc.its_logo_url), sponsor: await prepLogo(yc.sponsor_logo_url) };

    // Live counts per event × age-group (as the review screen computes them).
    const { rows: cells } = await pool.query(
      `SELECT e.id AS event_id, e.event_code, e.event_name, e.gender_split, e.is_stage_event, e.category_id,
              ag.id AS ag_id, ag.code AS ag_code, ag.label AS ag_label, ag.sort_order AS ag_sort,
              COUNT(r.id)::int AS count
         FROM registrations r
         JOIN events e ON e.id = r.event_id AND e.is_cancelled = FALSE AND e.is_generated = FALSE
         LEFT JOIN age_groups ag ON ag.id = r.age_group_id
         LEFT JOIN participants p ON p.id = r.participant_id
        WHERE r.year_id = $1 AND r.status NOT IN ('withdrawn','swapped')
          AND r.team_id IS NULL AND e.event_kind = 'individual'
          AND p.confirmed_at IS NOT NULL
        GROUP BY e.id, e.event_code, e.event_name, e.gender_split, e.is_stage_event, e.category_id,
                 ag.id, ag.code, ag.label, ag.sort_order`, [y.id]);

    const { rows: cons } = await pool.query(
      `SELECT ec.kind, ec.source_event_ids, ec.target_event_ids, ec.moved, ec.age_group_id,
              ag.code AS ag_code, ag.label AS ag_label, ag.sort_order AS ag_sort
         FROM event_consolidations ec LEFT JOIN age_groups ag ON ag.id = ec.age_group_id
        WHERE ec.year_id = $1 AND ec.reverted_at IS NULL AND ec.kind IN ('cancel','merge','split')`, [y.id]);

    const ids = new Set();
    cons.forEach((c) => { (c.source_event_ids||[]).forEach((i)=>ids.add(i)); (c.target_event_ids||[]).forEach((i)=>ids.add(i)); });
    const nameById = new Map();
    if (ids.size) { const { rows: evs } = await pool.query(`SELECT id, event_code, event_name FROM events WHERE id = ANY($1)`, [[...ids]]); evs.forEach((e)=>nameById.set(e.id, e)); }
    const nm = (id) => { const e = nameById.get(id); return e ? `${e.event_name} (${e.event_code})` : `#${id}`; };
    const cnt = (c) => Array.isArray(c.moved) ? c.moved.length : 0;

    const byKey = new Map();
    for (const c of cells) { c.base = baseName(c.event_name); const k = `${c.base.toLowerCase()}|${c.category_id}|${c.ag_id}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(c); }

    const cancelled = [], merged = [], splits = [];
    const executedCancel = new Set(), executedMerge = new Set();
    for (const c of cons) {
      if (c.kind === 'cancel') { executedCancel.add(`${c.source_event_ids[0]}:${c.age_group_id}`);
        cancelled.push({ ag_code: c.ag_code, ag_sort: c.ag_sort, ag_label: c.ag_label, label: nm(c.source_event_ids[0]), count: cnt(c), done: true }); }
      else if (c.kind === 'merge') { (c.source_event_ids||[]).forEach((i)=>executedMerge.add(`${i}:${c.age_group_id}`));
        merged.push({ ag_code: c.ag_code, ag_sort: c.ag_sort, ag_label: c.ag_label, src: (c.source_event_ids||[]).map(nm).join(' + '), tgt: (c.target_event_ids&&c.target_event_ids[0]) ? nm(c.target_event_ids[0]) : '(combined)', count: cnt(c), done: true }); }
      else if (c.kind === 'split') { splits.push({ ag_code: c.ag_code, ag_sort: c.ag_sort, ag_label: c.ag_label, src: nm(c.source_event_ids[0]), tgt: (c.target_event_ids||[]).map(nm).join(' + '), done: true }); }
    }
    const seenPair = new Set();
    for (const c of cells) {
      const key = `${c.event_id}:${c.ag_id}`;
      if (executedCancel.has(key) || executedMerge.has(key)) continue;
      if (c.is_stage_event && c.count > split) { splits.push({ ag_code: c.ag_code, ag_sort: c.ag_sort, ag_label: c.ag_label, src: `${c.event_name} (${c.event_code})`, tgt: 'two groups', count: c.count, done: false }); continue; }
      if (c.count < min) {
        let partner = null;
        if (c.gender_split === 'boys' || c.gender_split === 'girls') {
          const k = `${c.base.toLowerCase()}|${c.category_id}|${c.ag_id}`;
          partner = (byKey.get(k)||[]).find((o)=>o.event_id!==c.event_id && (o.gender_split==='boys'||o.gender_split==='girls') && o.gender_split!==c.gender_split);
        }
        if (partner && (c.count + partner.count) >= min) {
          const pk = [c.event_id, partner.event_id].sort((a,b)=>a-b).join('-') + ':' + c.ag_id;
          if (seenPair.has(pk)) continue; seenPair.add(pk);
          merged.push({ ag_code: c.ag_code, ag_sort: c.ag_sort, ag_label: c.ag_label, src: `${c.event_name} (${c.event_code}) + ${partner.event_name} (${partner.event_code})`, tgt: `${c.base} (Common)`, count: c.count + partner.count, done: false });
        } else {
          cancelled.push({ ag_code: c.ag_code, ag_sort: c.ag_sort, ag_label: c.ag_label, label: `${c.event_name} (${c.event_code})`, count: c.count, done: false });
        }
      }
    }
    // Within each age group, order by entry count ascending (1-entry first) so the
    // office can offer the smallest events a move first and lift near-threshold ones.
    const byCount = (a, b) => (a.ag_sort ?? 99) - (b.ag_sort ?? 99) || (a.count ?? 0) - (b.count ?? 0) || String(a.label || a.src).localeCompare(String(b.label || b.src));
    cancelled.sort(byCount); merged.sort(byCount); splits.sort(byCount);

    const doc = new PDFDocument({ margin: 45, size: 'A4', bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="changes-and-cancellations.pdf"');
    doc.pipe(res);

    const M = doc.page.margins.left, W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const topY = doc.page.margins.top, logoH = 46;
    if (logos.kca)     { try { doc.image(logos.kca, M, topY, { fit: [72, logoH] }); } catch { /* */ } }
    if (logos.sponsor) { try { doc.image(logos.sponsor, doc.page.width - doc.page.margins.right - 72, topY, { fit: [72, logoH] }); } catch { /* */ } }
    if (logos.its)     { try { doc.image(logos.its, (doc.page.width/2) - 26, topY - 2, { fit: [52, logoH + 4] }); } catch { /* */ } }
    doc.fillColor('#1e3a5f').font('Helvetica-Bold').fontSize(15).text(yc.event_year_label || 'KCA Indian Talent Scan', M, topY + logoH + 4, { width: W, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#1e3a5f').text('Changes & Cancellations', { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(9.5).fillColor('#64748b').text(`Prepared ${new Date().toLocaleString('en-GB')}`, { width: W, align: 'center' });
    doc.moveDown(1);

    const H = doc.page.height;
    const sectionTitle = (t, color) => { if (doc.y > H - 120) doc.addPage(); doc.moveDown(0.6); doc.font('Helvetica-Bold').fontSize(12.5).fillColor(color).text(t, M, doc.y, { width: W }); doc.moveDown(0.3); };
    const line = (txt, color) => { if (doc.y > H - 70) doc.addPage(); doc.font('Helvetica').fontSize(10).fillColor(color || '#334155').text(txt, { indent: 18, width: W - 18 }); };
    const note = (txt) => { doc.moveDown(0.25); doc.font('Helvetica-Oblique').fontSize(9).fillColor('#64748b').text(txt, { indent: 10, width: W - 10 }); };
    const groupLabel = (code, label) => label ? `${label} (${code})` : code;

    // Render items grouped by age group, with a sub-heading and spacing between groups.
    const renderByGroup = (items, fmt) => {
      if (items.length === 0) { line('None.'); return; }
      const gm = new Map();
      for (const it of items) { const k = it.ag_code || '—'; if (!gm.has(k)) gm.set(k, { sort: it.ag_sort ?? 99, code: k, label: it.ag_label || '', items: [] }); gm.get(k).items.push(it); }
      const ordered = [...gm.values()].sort((a, b) => (a.sort - b.sort) || a.code.localeCompare(b.code));
      ordered.forEach((g, gi) => {
        if (doc.y > H - 90) doc.addPage(); else if (gi > 0) doc.moveDown(0.5);
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#0f172a').text(groupLabel(g.code, g.label), M + 4, doc.y, { width: W - 4 });
        doc.moveDown(0.15);
        g.items.forEach((it, ix) => line(`${ix + 1}.  ${fmt(it)}`));
      });
    };

    sectionTitle(`Events with fewer than ${min} entries — at risk of cancellation`, '#b91c1c');
    renderByGroup(cancelled, (c) => `${c.label}  ·  ${c.count} entr${c.count === 1 ? 'y' : 'ies'}${c.done ? '  (cancelled)' : ''}`);
    note(`Listed smallest first within each age group. A child entered in any of these events may switch to ANY other event they are eligible for — not only the events in this list. Choosing an event that is just short of the minimum (for example one with ${min - 2} or ${min - 1} entries) can lift it to ${min} and keep it running. Alternatively, the entry fee can be refunded. To make a change, please contact the KCA office.`);

    sectionTitle('Events being combined (Boys + Girls merged)', '#1e3a5f');
    renderByGroup(merged, (c) => `${c.src}  ->  ${c.tgt}  ·  ${c.count} entries${c.done ? '  (confirmed)' : ''}`);
    note('No action is needed for combined events — entries move automatically and will appear in the schedule.');

    if (splits.length) {
      sectionTitle('Events being split (large entries)', '#7c3aed');
      renderByGroup(splits, (c) => `${c.src}  ->  ${c.tgt}${c.count ? `  ·  ${c.count} entries` : ''}${c.done ? '  (confirmed)' : ''}`);
      note('No action is needed — these are divided into two groups for judging.');
    }

    // Page numbers — zero the bottom margin while writing into it so pdfkit does
    // not auto-append a blank page per footer.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const ob = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(8).fillColor('#94a3b8')
         .text(`Page ${i + 1} of ${range.count}`, doc.page.margins.left, doc.page.height - 30, { width: W, align: 'center', lineBreak: false });
      doc.page.margins.bottom = ob;
    }

    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'EXPORT_CHANGES_PDF',
      entity: 'event_consolidations', entityId: null, details: { cancelled: cancelled.length, merged: merged.length, splits: splits.length } });

    doc.end();
  } catch (err) { next(err); }
});

// ── GET /affected-xlsx ────────────────────────────────────────────────────────
// Excel for office follow-up: every under-strength (fewer than the minimum)
// INDIVIDUAL event, with each affected participant and their contact details
// (parent name, phone, WhatsApp, email). One row per participant. Read-only.
router.get('/affected-xlsx', requireRole(...VIEW_ROLES), async (req, res, next) => {
  try {
    const y = await activeYear();
    if (!y) return res.status(400).json({ error: 'No active year' });
    const min = Number(y.min_threshold || 5);

    const { rows } = await pool.query(
      `WITH cell AS (
         SELECT r.event_id, r.age_group_id, COUNT(*)::int AS cnt
           FROM registrations r
           JOIN events e ON e.id = r.event_id AND e.event_kind = 'individual' AND e.is_cancelled = FALSE AND e.is_generated = FALSE
           JOIN participants p ON p.id = r.participant_id
          WHERE r.year_id = $1 AND r.status NOT IN ('withdrawn','swapped') AND r.team_id IS NULL AND p.confirmed_at IS NOT NULL
          GROUP BY r.event_id, r.age_group_id
       )
       SELECT c.event_id, c.age_group_id, ag.code AS ag_code, ag.label AS ag_label, ag.sort_order AS ag_sort,
              e.event_name, e.event_code, e.gender_split, e.category_id, c.cnt,
              p.full_name, p.cpr_number, p.gender, p.guardian_phone,
              u.full_name AS parent_name, u.email AS parent_email, u.phone AS parent_phone,
              u.whatsapp_number, u.whatsapp_number_2
         FROM cell c
         JOIN registrations r ON r.event_id = c.event_id AND r.age_group_id = c.age_group_id
              AND r.status NOT IN ('withdrawn','swapped') AND r.team_id IS NULL
         JOIN participants p ON p.id = r.participant_id AND p.confirmed_at IS NOT NULL
         JOIN events e ON e.id = c.event_id
         LEFT JOIN age_groups ag ON ag.id = c.age_group_id
         LEFT JOIN users u ON u.id = p.created_by
        WHERE c.cnt < $2
        ORDER BY ag.sort_order NULLS LAST, c.cnt, e.event_name, p.full_name`,
      [y.id, min]);

    // Only events that will be CANCELLED belong here — not Boys/Girls pairs that
    // will be MERGED (those parents need no follow-up). Mirror the Changes sheet:
    // include already-cancelled cells, exclude cells that merge into a Common
    // event, and exclude an under-strength cell that has a viable merge partner.
    const { rows: allCells } = await pool.query(
      `SELECT r.event_id, r.age_group_id, COUNT(*)::int AS cnt, e.event_name, e.gender_split, e.category_id
         FROM registrations r
         JOIN events e ON e.id = r.event_id AND e.event_kind = 'individual' AND e.is_cancelled = FALSE AND e.is_generated = FALSE
         JOIN participants p ON p.id = r.participant_id
        WHERE r.year_id = $1 AND r.status NOT IN ('withdrawn','swapped') AND r.team_id IS NULL AND p.confirmed_at IS NOT NULL
        GROUP BY r.event_id, r.age_group_id, e.event_name, e.gender_split, e.category_id`, [y.id]);
    const { rows: cons } = await pool.query(
      `SELECT kind, source_event_ids, age_group_id FROM event_consolidations
        WHERE year_id = $1 AND reverted_at IS NULL AND kind IN ('cancel','merge')`, [y.id]);
    const executedCancel = new Set(), executedMerge = new Set();
    for (const c of cons) {
      if (c.kind === 'cancel') executedCancel.add(`${c.source_event_ids[0]}:${c.age_group_id}`);
      else if (c.kind === 'merge') (c.source_event_ids || []).forEach((i) => executedMerge.add(`${i}:${c.age_group_id}`));
    }
    const byKey = new Map();
    for (const cc of allCells) { const b = baseName(cc.event_name); const k = `${b.toLowerCase()}|${cc.category_id}|${cc.age_group_id}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(cc); }
    const atRisk = (r) => {
      const key = `${r.event_id}:${r.age_group_id}`;
      if (executedCancel.has(key)) return true;
      if (executedMerge.has(key)) return false;
      if (Number(r.cnt) >= min) return false;
      if (r.gender_split === 'boys' || r.gender_split === 'girls') {
        const b = baseName(r.event_name);
        const partner = (byKey.get(`${b.toLowerCase()}|${r.category_id}|${r.age_group_id}`) || [])
          .find((o) => o.event_id !== r.event_id && (o.gender_split === 'boys' || o.gender_split === 'girls') && o.gender_split !== r.gender_split);
        if (partner && (Number(r.cnt) + Number(partner.cnt)) >= min) return false; // will be merged
      }
      return true;
    };

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'KCA ITS'; wb.created = new Date();
    const ws = wb.addWorksheet('Under-strength events');
    ws.columns = [
      { header: 'Age Group', key: 'ag', width: 18 },
      { header: 'Event', key: 'event', width: 34 },
      { header: 'Code', key: 'code', width: 8 },
      { header: 'Entries in event', key: 'cnt', width: 14 },
      { header: 'Participant', key: 'name', width: 26 },
      { header: 'CPR', key: 'cpr', width: 14 },
      { header: 'Gender', key: 'gender', width: 8 },
      { header: 'Parent', key: 'parent', width: 24 },
      { header: 'Phone', key: 'phone', width: 16 },
      { header: 'WhatsApp', key: 'wa', width: 16 },
      { header: 'WhatsApp 2', key: 'wa2', width: 16 },
      { header: 'Email', key: 'email', width: 28 },
    ];
    let added = 0;
    for (const r of rows) {
      if (!atRisk(r)) continue;
      added += 1;
      ws.addRow({
        ag: r.ag_label ? `${r.ag_label} (${r.ag_code})` : r.ag_code,
        event: r.event_name, code: r.event_code, cnt: r.cnt,
        name: String(r.full_name || '').toUpperCase(), cpr: r.cpr_number, gender: r.gender || '',
        parent: r.parent_name || '', phone: r.guardian_phone || r.parent_phone || '',
        wa: r.whatsapp_number || '', wa2: r.whatsapp_number_2 || '', email: r.parent_email || '',
      });
    }
    const h = ws.getRow(1); h.font = { bold: true }; ws.views = [{ state: 'frozen', ySplit: 1 }];

    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'EXPORT_AFFECTED_XLSX',
      entity: 'event_consolidations', entityId: null, details: { rows: added, min } });

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="cancelled-events-followup.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) { next(err); }
});


// ── GET /affected-resolutions-xlsx ────────────────────────────────────────────
// Reconciliation ledger of every cancelled entry and the action taken on it
// (switched to which event / refunded), with the fee effect — for the office to
// re-confirm each change. Built from the resolution audit trail + current state.
router.get('/affected-resolutions-xlsx', requireRole(...VIEW_ROLES), async (req, res, next) => {
  try {
    const y = await activeYear();
    if (!y) return res.status(400).json({ error: 'No active year' });

    const { rows } = await pool.query(
      `SELECT m.reg_id, ec.age_group_id,
              r.status AS reg_status, r.fee_amount,
              p.full_name, p.cpr_number, p.gender,
              ag.code AS ag_code, ag.label AS ag_label, ag.sort_order AS ag_sort,
              ce.event_code AS cancelled_code, ce.event_name AS cancelled_name,
              u.full_name AS parent_name,
              COALESCE(u.whatsapp_number, u.phone) AS parent_contact,
              (SELECT COUNT(*)::int FROM refunds rf WHERE rf.registration_id = m.reg_id) AS refund_count,
              act.action AS act_action, act.changed_at AS resolved_at, au.full_name AS resolved_by,
              te.event_code AS to_code, te.event_name AS to_name,
              (act.new_value->>'old_fee')::numeric        AS act_old_fee,
              (act.new_value->>'new_fee')::numeric        AS act_new_fee,
              (act.new_value->>'additional_due')::numeric AS act_add_due,
              COALESCE((act.new_value->>'refund_due')::numeric,
                       (act.new_value->>'refund_amount')::numeric) AS act_refund
         FROM event_consolidations ec
         CROSS JOIN LATERAL jsonb_to_recordset(ec.moved) AS m(reg_id int, from_event_id int, to_event_id int)
         JOIN registrations r ON r.id = m.reg_id
         JOIN participants p ON p.id = r.participant_id
         LEFT JOIN age_groups ag ON ag.id = ec.age_group_id
         LEFT JOIN events ce ON ce.id = ec.source_event_ids[1]
         LEFT JOIN users u ON u.id = p.created_by
         LEFT JOIN LATERAL (
           SELECT al.new_value, al.action, al.changed_by, al.changed_at
             FROM audit_log al
            WHERE al.table_name = 'registrations' AND al.record_id = m.reg_id
              AND al.action IN ('CONSOLIDATE_SWITCH','CONSOLIDATE_REFUND')
            ORDER BY al.id DESC LIMIT 1
         ) act ON TRUE
         LEFT JOIN events te ON te.id = (act.new_value->>'to_event_id')::int
         LEFT JOIN users au ON au.id = act.changed_by
        WHERE ec.year_id = $1 AND ec.kind = 'cancel' AND ec.reverted_at IS NULL
        ORDER BY ag.sort_order NULLS LAST, p.full_name`, [y.id]);

    const fmt = (v) => (v == null ? '' : Number(v).toFixed(3));
    const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Bahrain' }) : '');

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'KCA ITS'; wb.created = new Date();
    const ws = wb.addWorksheet('Resolutions');
    ws.columns = [
      { header: 'Age Group', key: 'ag', width: 18 },
      { header: 'Participant', key: 'name', width: 26 },
      { header: 'CPR', key: 'cpr', width: 14 },
      { header: 'Gender', key: 'gender', width: 8 },
      { header: 'Parent', key: 'parent', width: 24 },
      { header: 'Contact', key: 'contact', width: 16 },
      { header: 'Cancelled Code', key: 'ccode', width: 14 },
      { header: 'Cancelled Event', key: 'cevent', width: 30 },
      { header: 'Original Fee (BD)', key: 'ofee', width: 15 },
      { header: 'Action', key: 'action', width: 12 },
      { header: 'Switched To', key: 'to', width: 34 },
      { header: 'New Fee (BD)', key: 'nfee', width: 13 },
      { header: 'Additional Due (BD)', key: 'add', width: 17 },
      { header: 'Refund (BD)', key: 'refund', width: 13 },
      { header: 'Resolved By', key: 'by', width: 18 },
      { header: 'When (Bahrain)', key: 'at', width: 20 },
    ];

    let nSwitched = 0, nRefunded = 0, nOpen = 0;
    for (const r of rows) {
      let action = 'open';
      if (r.reg_status === 'withdrawn' && r.refund_count > 0) action = 'refunded';
      else if (r.reg_status === 'swapped') action = 'switched';
      else if (r.reg_status !== 'registered') action = 'closed';
      if (action === 'switched') nSwitched += 1;
      else if (action === 'refunded') nRefunded += 1;
      else if (action === 'open') nOpen += 1;

      ws.addRow({
        ag: r.ag_label ? `${r.ag_label} (${r.ag_code})` : (r.ag_code || ''),
        name: String(r.full_name || '').toUpperCase(),
        cpr: r.cpr_number || '', gender: r.gender || '',
        parent: r.parent_name || '', contact: r.parent_contact || '',
        ccode: r.cancelled_code || '', cevent: r.cancelled_name || '',
        ofee: fmt(r.fee_amount),
        action,
        to: action === 'switched' && r.to_code ? `${r.to_code} — ${r.to_name}` : '',
        nfee: action === 'switched' ? fmt(r.act_new_fee) : '',
        add: action === 'switched' ? fmt(r.act_add_due) : '',
        refund: fmt(r.act_refund),
        by: r.resolved_by || '', at: when(r.resolved_at),
      });
    }

    const h = ws.getRow(1); h.font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: 'A1', to: 'P1' };

    // Summary line beneath the table.
    ws.addRow({});
    const sum = ws.addRow({ name: `Total ${rows.length}  ·  Switched ${nSwitched}  ·  Refunded ${nRefunded}  ·  Open ${nOpen}` });
    sum.font = { italic: true, color: { argb: 'FF666666' } };

    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'EXPORT_RESOLUTIONS_XLSX',
      entity: 'event_consolidations', entityId: null,
      details: { rows: rows.length, switched: nSwitched, refunded: nRefunded, open: nOpen } });

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="cancelled-entries-resolutions.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) { next(err); }
});

module.exports = router;

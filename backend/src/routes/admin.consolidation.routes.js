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

const router = express.Router();
router.use(authenticate);

const VIEW_ROLES  = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'];
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
          AND (p.confirmed_at IS NOT NULL OR r.team_id IS NOT NULL)
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
        age_group_label: c.age_group_label, ag_sort: c.ag_sort,
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


module.exports = router;

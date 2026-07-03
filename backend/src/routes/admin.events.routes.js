// src/routes/admin.events.routes.js  (mounted at /api/admin)
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { sendWhatsApp } = require('../utils/notify');

const router = express.Router();
router.use(authenticate);

const staffRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'];
const editRoles  = ['SuperAdmin', 'Admin', 'Coordinator'];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function attachCriteriaAndAgeGroups(client, rows) {
  if (!rows.length) return rows;
  const eventIds = rows.map((r) => r.id);

  const { rows: criteriaRows } = await client.query(
    `SELECT event_id, criterion_name AS label, max_score, sequence_order
     FROM event_criteria WHERE event_id = ANY($1)
     ORDER BY event_id, sequence_order`,
    [eventIds],
  );

  const { rows: agRows } = await client.query(
    `SELECT eag.event_id, ag.code, eag.allotted_time_seconds
     FROM event_age_groups eag
     JOIN age_groups ag ON ag.id = eag.age_group_id
     WHERE eag.event_id = ANY($1)
     ORDER BY eag.event_id, ag.sort_order`,
    [eventIds],
  );

  const criteriaMap = {};
  for (const c of criteriaRows) {
    if (!criteriaMap[c.event_id]) criteriaMap[c.event_id] = [];
    criteriaMap[c.event_id].push({ label: c.label, max_score: Number(c.max_score) });
  }

  const ageGroupMap = {};
  const durationMap = {};
  for (const ag of agRows) {
    if (!ageGroupMap[ag.event_id]) ageGroupMap[ag.event_id] = [];
    ageGroupMap[ag.event_id].push(ag.code);
    if (ag.allotted_time_seconds != null) {
      if (!durationMap[ag.event_id]) durationMap[ag.event_id] = {};
      durationMap[ag.event_id][ag.code] = ag.allotted_time_seconds;
    }
  }

  // Time slots (frontend field names: label / capacity / reporting_time)
  const { rows: slotRows } = await client.query(
    `SELECT event_id, slot_label AS label, reporting_time,
            participant_capacity AS capacity, chest_no_start, sort_order
     FROM event_time_slots WHERE event_id = ANY($1)
     ORDER BY event_id, sort_order`,
    [eventIds],
  );
  const slotMap = {};
  for (const sl of slotRows) {
    if (!slotMap[sl.event_id]) slotMap[sl.event_id] = [];
    slotMap[sl.event_id].push({
      label: sl.label,
      reporting_time: sl.reporting_time,
      capacity: sl.capacity,
      chest_no_start: sl.chest_no_start,
    });
  }

  rows.forEach((row) => {
    row.criteria            = criteriaMap[row.id] || [];
    row.age_groups          = ageGroupMap[row.id] || [];
    row.age_group_durations = durationMap[row.id] || {};
    row.slots               = slotMap[row.id]     || [];
  });

  return rows;
}

async function saveCriteria(client, eventId, criteria) {
  await client.query(`DELETE FROM event_criteria WHERE event_id = $1`, [eventId]);
  for (const [i, c] of (criteria || []).entries()) {
    if (c.label?.trim()) {
      await client.query(
        `INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
         VALUES ($1, $2, $3, $4)`,
        [eventId, c.label.trim(), Number(c.max_score) || 0, i + 1],
      );
    }
  }
}

async function saveAgeGroups(client, eventId, yearId, agCodes, durations = {}) {
  await client.query(`DELETE FROM event_age_groups WHERE event_id = $1`, [eventId]);
  if (!agCodes?.length) return;
  const { rows: agRows } = await client.query(
    `SELECT id, code FROM age_groups WHERE year_id = $1 AND code = ANY($2)`,
    [yearId, agCodes],
  );
  for (const ag of agRows) {
    const dur = durations?.[ag.code];
    await client.query(
      `INSERT INTO event_age_groups (event_id, age_group_id, allotted_time_seconds)
       VALUES ($1, $2, $3)`,
      [eventId, ag.id, dur != null && dur !== '' ? Number(dur) : null],
    );
  }
}

// Upsert slots by (event_id, slot_label); remove slots dropped from the list
// only when no registration references them (registrations.time_slot_id FK).
async function saveSlots(client, eventId, slots) {
  if (!Array.isArray(slots)) return; // undefined = leave untouched
  const keep = [];
  for (const [i, sl] of slots.entries()) {
    const label = (sl.label || sl.slot_label || '').trim();
    if (!label) continue;
    keep.push(label);
    await client.query(
      `INSERT INTO event_time_slots
         (event_id, slot_label, reporting_time, participant_capacity, chest_no_start, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (event_id, slot_label) DO UPDATE SET
         reporting_time = EXCLUDED.reporting_time,
         participant_capacity = EXCLUDED.participant_capacity,
         chest_no_start = EXCLUDED.chest_no_start,
         sort_order = EXCLUDED.sort_order`,
      [eventId, label, sl.reporting_time || null,
       Math.max(Number(sl.capacity ?? sl.participant_capacity) || 1, 1),
       sl.chest_no_start ?? null, i + 1],
    );
  }
  await client.query(
    `DELETE FROM event_time_slots ts
     WHERE ts.event_id = $1 AND NOT (ts.slot_label = ANY($2))
       AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.time_slot_id = ts.id)`,
    [eventId, keep],
  );
}

// ── Events Excel round-trip ──────────────────────────────────────────────────
// GET /api/admin/events/export  → CSV (opens directly in Excel; UTF-8 BOM).
// POST /api/admin/events/import → upsert by event_code for the active year.
// Multi-value cells: age_groups "G1|G2" · criteria "Rhythm:25|Costume:20" ·
// age_group_durations "G1:420|G2:600".

const EXPORT_COLUMNS = ['event_code', 'event_name', 'category_code', 'event_kind',
  'gender_split', 'fee_amount', 'member_fee_amount', 'is_stage_event',
  'age_groups', 'allotted_time_seconds', 'grace_period_seconds',
  'yellow_alert_seconds', 'age_group_durations', 'criteria', 'sort_order'];

function csvCell(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

/** Minimal RFC-4180 parser: quotes, embedded commas/newlines, CRLF, BOM. */
function parseCsv(text) {
  const src = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

router.get('/events/export', requireRole(...staffRoles), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows: cfg } = await client.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
    if (!cfg[0]) return res.status(400).json({ error: 'No active year config' });

    const { rows } = await client.query(
      `SELECT e.*, c.code AS category_code
       FROM events e LEFT JOIN categories c ON c.id = e.category_id
       WHERE e.year_id = $1 ORDER BY e.event_code`,
      [cfg[0].id],
    );
    await attachCriteriaAndAgeGroups(client, rows);

    const lines = [EXPORT_COLUMNS.join(',')];
    for (const e of rows) {
      lines.push(EXPORT_COLUMNS.map((col) => {
        switch (col) {
          case 'age_groups': return csvCell(e.age_groups.join('|'));
          case 'criteria': return csvCell(e.criteria.map((c) => `${c.label}:${Number(c.max_score)}`).join('|'));
          case 'age_group_durations':
            return csvCell(Object.entries(e.age_group_durations || {}).map(([k, v]) => `${k}:${v}`).join('|'));
          case 'is_stage_event': return csvCell(e.is_stage_event ? 'TRUE' : 'FALSE');
          default: return csvCell(e[col]);
        }
      }).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="its-events.csv"');
    res.send('\uFEFF' + lines.join('\r\n'));
  } catch (err) { next(err); }
  finally { client.release(); }
});

router.post('/events/import', requireRole('SuperAdmin', 'Admin'),
  express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }),
  async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!req.body || typeof req.body !== 'string' || !req.body.trim())
      return res.status(400).json({ error: 'Send the CSV file content as text/csv' });

    const rows = parseCsv(req.body);
    if (rows.length < 2) return res.status(400).json({ error: 'CSV has no data rows' });
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const idx = (name) => header.indexOf(name);
    if (idx('event_code') === -1 || idx('event_name') === -1)
      return res.status(400).json({ error: 'CSV must include event_code and event_name columns (use the exported file as the template)' });

    const { rows: cfg } = await client.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
    if (!cfg[0]) return res.status(400).json({ error: 'No active year config' });
    const year_id = cfg[0].id;

    const { rows: cats } = await client.query(`SELECT id, code FROM categories WHERE year_id = $1`, [year_id]);
    const catByCode = Object.fromEntries(cats.map((c) => [c.code.toUpperCase(), c.id]));
    const { rows: ags } = await client.query(`SELECT code FROM age_groups WHERE year_id = $1`, [year_id]);
    const validAg = new Set(ags.map((a) => a.code));

    // ── Validate every row first; import nothing if any row is invalid ──
    const errors = [];
    const parsed = [];
    const get = (r, name) => { const i = idx(name); return i === -1 ? undefined : (r[i] ?? '').trim(); };

    for (let rn = 1; rn < rows.length; rn++) {
      const r = rows[rn];
      const line = rn + 1;
      const ev = {
        event_code: get(r, 'event_code'),
        event_name: get(r, 'event_name'),
        category_code: (get(r, 'category_code') || '').toUpperCase(),
        event_kind: (get(r, 'event_kind') || 'individual').toLowerCase(),
        gender_split: (get(r, 'gender_split') || 'common').toLowerCase(),
        fee_amount: get(r, 'fee_amount'),
        member_fee_amount: get(r, 'member_fee_amount'),
        is_stage_event: /^(true|yes|1)$/i.test(get(r, 'is_stage_event') || ''),
        age_groups: (get(r, 'age_groups') || '').split('|').map((x) => x.trim()).filter(Boolean),
        allotted_time_seconds: get(r, 'allotted_time_seconds'),
        grace_period_seconds: get(r, 'grace_period_seconds'),
        yellow_alert_seconds: get(r, 'yellow_alert_seconds'),
        sort_order: get(r, 'sort_order'),
        criteria_raw: get(r, 'criteria'),
        durations_raw: get(r, 'age_group_durations'),
      };
      if (!ev.event_code) { errors.push(`Row ${line}: event_code is required`); continue; }
      if (!ev.event_name) { errors.push(`Row ${line}: event_name is required`); continue; }
      if (ev.category_code && !catByCode[ev.category_code])
        errors.push(`Row ${line}: unknown category_code '${ev.category_code}' (valid: ${Object.keys(catByCode).join(', ')})`);
      if (!['individual', 'team'].includes(ev.event_kind))
        errors.push(`Row ${line}: event_kind must be individual or team`);
      if (!['none', 'boys', 'girls', 'common'].includes(ev.gender_split))
        errors.push(`Row ${line}: gender_split must be none/boys/girls/common`);
      for (const g of ev.age_groups)
        if (!validAg.has(g)) errors.push(`Row ${line}: unknown age group '${g}'`);

      ev.criteria = null;
      if (ev.criteria_raw) {
        ev.criteria = ev.criteria_raw.split('|').map((c) => {
          const m = c.trim().match(/^(.*):(\d+(?:\.\d+)?)$/);
          return m ? { label: m[1].trim(), max_score: Number(m[2]) } : null;
        });
        if (ev.criteria.some((c) => !c)) errors.push(`Row ${line}: criteria must look like 'Name:25|Name:75'`);
        else {
          const sum = ev.criteria.reduce((t, c) => t + c.max_score, 0);
          if (sum !== 100) errors.push(`Row ${line}: criteria max scores sum to ${sum}, must total exactly 100`);
          if (ev.criteria.length > 6) errors.push(`Row ${line}: at most 6 criteria allowed`);
        }
      }

      ev.durations = {};
      if (ev.durations_raw) {
        for (const part of ev.durations_raw.split('|')) {
          const m = part.trim().match(/^(\w+):(\d+)$/);
          if (!m) { errors.push(`Row ${line}: age_group_durations must look like 'G1:420|G2:600'`); break; }
          if (!validAg.has(m[1])) errors.push(`Row ${line}: duration for unknown age group '${m[1]}'`);
          ev.durations[m[1]] = Number(m[2]);
        }
      }
      parsed.push(ev);
    }

    if (errors.length) return res.status(400).json({ imported: 0, errors });

    // ── Apply in one transaction: upsert by (year_id, event_code) ──
    await client.query('BEGIN');
    let created = 0, updated = 0;
    for (const ev of parsed) {
      const category_id = ev.category_code ? catByCode[ev.category_code] : null;
      const numOrNull = (v) => (v === '' || v == null ? null : Number(v));
      const { rows: existing } = await client.query(
        `SELECT id FROM events WHERE year_id = $1 AND event_code = $2`,
        [year_id, ev.event_code],
      );
      let eventId;
      if (existing[0]) {
        eventId = existing[0].id;
        await client.query(
          `UPDATE events SET
             event_name = $1, category_id = COALESCE($2, category_id), event_kind = $3,
             gender_split = $4, is_stage_event = $5,
             fee_amount = COALESCE($6, fee_amount),
             member_fee_amount = $7,
             allotted_time_seconds = $8, grace_period_seconds = $9,
             yellow_alert_seconds = $10, sort_order = COALESCE($11, sort_order),
             updated_at = NOW()
           WHERE id = $12`,
          [ev.event_name, category_id, ev.event_kind, ev.gender_split, ev.is_stage_event,
           numOrNull(ev.fee_amount), numOrNull(ev.member_fee_amount),
           numOrNull(ev.allotted_time_seconds), numOrNull(ev.grace_period_seconds),
           numOrNull(ev.yellow_alert_seconds), numOrNull(ev.sort_order), eventId],
        );
        updated++;
      } else {
        const { rows: ins } = await client.query(
          `INSERT INTO events
             (year_id, category_id, event_code, event_name, event_kind, gender_split,
              is_stage_event, fee_amount, member_fee_amount, allotted_time_seconds,
              grace_period_seconds, yellow_alert_seconds, sort_order, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW()) RETURNING id`,
          [year_id, category_id, ev.event_code, ev.event_name, ev.event_kind, ev.gender_split,
           ev.is_stage_event, numOrNull(ev.fee_amount) ?? 0, numOrNull(ev.member_fee_amount),
           numOrNull(ev.allotted_time_seconds), numOrNull(ev.grace_period_seconds),
           numOrNull(ev.yellow_alert_seconds), numOrNull(ev.sort_order) ?? 0],
        );
        eventId = ins[0].id;
        created++;
      }
      if (ev.criteria) await saveCriteria(client, eventId, ev.criteria);
      if (ev.age_groups.length) await saveAgeGroups(client, eventId, year_id, ev.age_groups, ev.durations);
    }
    await client.query('COMMIT');

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'IMPORT_EVENTS', entity: 'events', entityId: year_id,
      details: { created, updated } });
    res.json({ created, updated, errors: [] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── GET /api/admin/categories ────────────────────────────────────────────────
router.get('/categories', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows: config } = await pool.query(
      `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    if (!config[0]) return res.json([]);
    const { rows } = await pool.query(
      `SELECT id, code, name, sort_order FROM categories
       WHERE year_id = $1 ORDER BY sort_order, id`,
      [config[0].id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/events ────────────────────────────────────────────────────
router.get('/events', requireRole(...staffRoles), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows: config } = await client.query(
      `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    const year_id = config[0]?.id || null;

    const { rows } = await client.query(
      `SELECT e.*, c.name AS category_name, c.code AS category_code
       FROM events e
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE ($1::int IS NULL OR e.year_id = $1)
       ORDER BY c.sort_order, e.sort_order, e.id`,
      [year_id],
    );

    await attachCriteriaAndAgeGroups(client, rows);
    res.json(rows);
  } catch (err) { next(err); }
  finally { client.release(); }
});

// ── GET /api/admin/events/:id ────────────────────────────────────────────────
router.get('/events/:id', requireRole(...staffRoles), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT e.*, c.name AS category_name, c.code AS category_code
       FROM events e
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE e.id = $1`,
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Event not found' });
    await attachCriteriaAndAgeGroups(client, rows);
    res.json(rows[0]);
  } catch (err) { next(err); }
  finally { client.release(); }
});

// ── POST /api/admin/events ───────────────────────────────────────────────────
router.post('/events', requireRole(...editRoles), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      event_code, event_name, category_id,
      event_kind     = 'individual',
      is_stage_event = false,
      time_slot_mode = false,
      criteria       = [],
      age_groups     = [],
      fee_amount     = 0,
      member_fee_amount = null,
      gender_split   = 'common',
      allotted_time_seconds = null,
      grace_period_seconds = null,
      yellow_alert_seconds = null,
      age_group_durations = {},
      slots,
    } = req.body;

    if (!event_code || !event_name || !category_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'event_code, event_name, category_id are required' });
    }

    const { rows: cfg } = await client.query(
      `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    if (!cfg[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No active year config' }); }
    const year_id = cfg[0].id;

    const { rows } = await client.query(
      `INSERT INTO events
         (year_id, category_id, event_code, event_name, event_kind,
          is_stage_event, time_slot_mode, fee_amount, member_fee_amount,
          gender_split, allotted_time_seconds, grace_period_seconds,
          yellow_alert_seconds, sort_order, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,NOW(),NOW()) RETURNING *`,
      [year_id, category_id, event_code, event_name, event_kind, is_stage_event,
       time_slot_mode, fee_amount, member_fee_amount, gender_split,
       allotted_time_seconds || null, grace_period_seconds || null, yellow_alert_seconds || null],
    );
    const eventId = rows[0].id;

    await saveCriteria(client, eventId, criteria);
    await saveAgeGroups(client, eventId, year_id, age_groups, age_group_durations);
    await saveSlots(client, eventId, slots);

    await client.query('COMMIT');

    rows[0].criteria   = criteria.filter((c) => c.label?.trim()).map((c) => ({ label: c.label, max_score: Number(c.max_score) || 0 }));
    rows[0].age_groups = age_groups;

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'CREATE_EVENT', entity: 'events', entityId: eventId });
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── PUT /api/admin/events/:id ────────────────────────────────────────────────
router.put('/events/:id', requireRole(...editRoles), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      event_code, event_name, category_id, event_kind,
      is_stage_event, time_slot_mode,
      criteria, age_groups, age_group_durations,
      fee_amount, member_fee_amount, gender_split,
      allotted_time_seconds, grace_period_seconds, yellow_alert_seconds,
      slots,
    } = req.body;

    const { rows } = await client.query(
      `UPDATE events SET
         event_code     = COALESCE($1, event_code),
         event_name     = COALESCE($2, event_name),
         category_id    = COALESCE($3, category_id),
         event_kind     = COALESCE($4, event_kind),
         is_stage_event = COALESCE($5, is_stage_event),
         time_slot_mode = COALESCE($6, time_slot_mode),
         fee_amount     = COALESCE($7, fee_amount),
         member_fee_amount = COALESCE($8, member_fee_amount),
         gender_split   = COALESCE($9, gender_split),
         allotted_time_seconds = COALESCE($10, allotted_time_seconds),
         grace_period_seconds  = COALESCE($11, grace_period_seconds),
         yellow_alert_seconds  = COALESCE($12, yellow_alert_seconds),
         updated_at     = NOW()
       WHERE id = $13 RETURNING *`,
      [event_code, event_name, category_id, event_kind, is_stage_event, time_slot_mode,
       fee_amount, member_fee_amount, gender_split,
       allotted_time_seconds || null, grace_period_seconds || null, yellow_alert_seconds || null,
       req.params.id],
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found' }); }

    if (Array.isArray(criteria))   await saveCriteria(client, req.params.id, criteria);
    if (Array.isArray(age_groups)) await saveAgeGroups(client, req.params.id, rows[0].year_id, age_groups, age_group_durations);
    await saveSlots(client, req.params.id, slots);

    await client.query('COMMIT');

    rows[0].criteria   = Array.isArray(criteria)   ? criteria.filter((c) => c.label?.trim())   : [];
    rows[0].age_groups = Array.isArray(age_groups) ? age_groups : [];

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'UPDATE_EVENT', entity: 'events', entityId: req.params.id, details: req.body });
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── DELETE /api/admin/events/:id ─────────────────────────────────────────────
router.delete('/events/:id', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM events WHERE id = $1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Event not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'DELETE_EVENT', entity: 'events', entityId: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── POST /api/admin/events/:id/cancel ────────────────────────────────────────
router.post('/events/:id/cancel', requireRole('SuperAdmin', 'Admin', 'Chairman'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: evRows } = await client.query(
      `UPDATE events SET is_cancelled = TRUE, cancelled_at = NOW(),
        cancel_reason = $2, cancelled_by = $3
       WHERE id = $1 RETURNING *`,
      [req.params.id, req.body.reason || null, req.user.id],
    );
    if (!evRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found' }); }

    // Fetch affected registrations before updating status
    const { rows: affected } = await client.query(
      `SELECT r.id AS registration_id, p.full_name AS participant_name,
              p.guardian_phone
       FROM registrations r
       JOIN participants p ON p.id = r.participant_id
       WHERE r.event_id = $1 AND r.status = 'registered'`,
      [req.params.id],
    );

    // Use 'withdrawn' — cancelled_event is not a valid registration_status enum value.
    // Swap eligibility is identified by checking event.is_cancelled = TRUE on the source event.
    await client.query(
      `UPDATE registrations SET status = 'withdrawn', updated_at = NOW()
       WHERE event_id = $1 AND status = 'registered'`,
      [req.params.id],
    );
    await client.query('COMMIT');

    for (const reg of affected) {
      await sendWhatsApp(
        reg.guardian_phone,
        `${evRows[0].event_name} has been cancelled. Please contact the admin to request a swap into another event.`,
      ).catch(() => null);
    }
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'CANCEL_EVENT', entity: 'events', entityId: req.params.id,
      details: { affectedCount: affected.length } });
    res.json({ event: evRows[0], affectedRegistrations: affected.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

module.exports = router;

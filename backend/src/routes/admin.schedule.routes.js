// src/routes/admin.schedule.routes.js  (mounted at /api/admin/schedule)
//
// Schedule preparation (Blueprint §4.7 / §12.2 AUTO SCHEDULE DRAFT):
//   POST /generate-draft — runs the unit-tested scheduler service over the
//        competition window with the given venues + daily time blocks.
//        Constraints handled by the service: no participant in two events at
//        once, max 2 events/participant/day, same-category venue clustering.
//   GET  /                — current schedule rows (draft + confirmed)
//   PUT  /:id             — adjust a row (date/time/venue), audited
//   POST /publish         — draft → confirmed (Chairman/Admin), audited
//
// DB-verified schedule columns: id, year_id, event_id, time_slot_id,
// judge_assignment_id, event_date, start_time, end_time, venue,
// status('draft'|'confirmed'|'completed'), generated_by_scheduler.
// (The earlier schedule endpoints in admin.config.routes used non-existent
//  columns and a wrong service import — replaced by this file.)

const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { generateScheduleDraft } = require('../services/scheduler');

const router = express.Router();
router.use(authenticate);

const staffRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'EventStaff'];
const editRoles = ['SuperAdmin', 'Admin', 'Coordinator'];

async function activeYear() {
  const { rows } = await pool.query(
    `SELECT id, event_start_date, event_end_date FROM year_config WHERE is_active = TRUE LIMIT 1`);
  return rows[0] || null;
}

/** Local YYYY-MM-DD (pg DATE parses to local midnight; toISOString would
 *  shift a day west of UTC — Bahrain is +03, so always format locally). */
const localISO = (d) => new Date(d).toLocaleDateString('en-CA');

/** All dates (YYYY-MM-DD) from start to end inclusive. */
function dateRange(start, end) {
  const out = [];
  const d = new Date(start);
  const stop = new Date(end);
  while (d <= stop) {
    out.push(localISO(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// ── Venues / facility setup ──────────────────────────────────────────────────
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// GET /api/admin/schedule/venues
router.get('/venues', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.json([]);
    const { rows } = await pool.query(
      `SELECT * FROM venues WHERE year_id = $1 ORDER BY sort_order, id`, [yc.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/admin/schedule/category-dates — per-category earliest ("not before")
// schedule date, e.g. dance late in the window so kids get more practice time.
router.get('/category-dates', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.json([]);
    const { rows } = await pool.query(
      `SELECT id, code, name, to_char(not_before_date, 'YYYY-MM-DD') AS not_before_date
       FROM categories WHERE year_id = $1 ORDER BY sort_order, id`, [yc.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// PUT /api/admin/schedule/category-dates — body: { dates: { <categoryId>: 'YYYY-MM-DD'|null } }
router.put('/category-dates', requireRole('SuperAdmin', 'Admin', 'Coordinator'), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });
    const dates = req.body?.dates || {};
    for (const [id, val] of Object.entries(dates)) {
      const d = val && /^\d{4}-\d{2}-\d{2}$/.test(val) ? val : null;
      await pool.query(
        `UPDATE categories SET not_before_date = $1 WHERE id = $2 AND year_id = $3`,
        [d, Number(id), yc.id]);
    }
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'SET_CATEGORY_DATES', entity: 'categories', entityId: yc.id, details: { dates } });
    const { rows } = await pool.query(
      `SELECT id, code, name, to_char(not_before_date, 'YYYY-MM-DD') AS not_before_date
       FROM categories WHERE year_id = $1 ORDER BY sort_order, id`, [yc.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// PUT /api/admin/schedule/venues — replace-all upsert (max 4 venues)
router.put('/venues', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { venues = [] } = req.body;
    if (venues.length > 4)
      return res.status(400).json({ error: 'At most 4 venues can be defined' });
    for (const v of venues) {
      if (!v.name?.trim()) return res.status(400).json({ error: 'Each venue needs a name' });
      for (const [day, h] of Object.entries(v.weekday_hours || {})) {
        if (!WEEKDAYS.includes(day))
          return res.status(400).json({ error: `Unknown weekday '${day}' (use sun..sat)` });
        if (!/^\d{2}:\d{2}$/.test(h?.start || '') || !/^\d{2}:\d{2}$/.test(h?.end || ''))
          return res.status(400).json({ error: `Venue ${v.name}: ${day} needs start/end as HH:MM` });
      }
      for (const d of (v.blocked_dates || [])) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d))
          return res.status(400).json({ error: `Venue ${v.name}: blocked date '${d}' must be YYYY-MM-DD` });
      }
    }
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });

    await client.query('BEGIN');
    const keep = [];
    for (const [i, v] of venues.entries()) {
      const { rows } = await client.query(
        `INSERT INTO venues (year_id, name, has_stage, capacity, suitable_for, weekday_hours, notes, sort_order, blocked_dates)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (year_id, name) DO UPDATE SET
           has_stage = EXCLUDED.has_stage, capacity = EXCLUDED.capacity,
           suitable_for = EXCLUDED.suitable_for, weekday_hours = EXCLUDED.weekday_hours,
           notes = EXCLUDED.notes, sort_order = EXCLUDED.sort_order,
           blocked_dates = EXCLUDED.blocked_dates
         RETURNING id`,
        [yc.id, v.name.trim(), v.has_stage !== false, v.capacity || null,
         v.suitable_for || [], JSON.stringify(v.weekday_hours || {}), v.notes || null, i,
         (v.blocked_dates || [])]);
      keep.push(rows[0].id);
    }
    await client.query(
      `DELETE FROM venues WHERE year_id = $1 AND NOT (id = ANY($2::int[]))`,
      [yc.id, keep.length ? keep : [0]]);
    await client.query('COMMIT');

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'UPDATE_VENUES', entity: 'venues', entityId: yc.id,
      details: { venues: venues.map((v) => v.name) } });
    const { rows } = await pool.query(
      `SELECT * FROM venues WHERE year_id = $1 ORDER BY sort_order, id`, [yc.id]);
    res.json(rows);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

/** Maps a category name to a suitability tag: dance/music/arts/literary. */
function categoryTag(name) {
  const n = (name || '').toLowerCase();
  if (/natya|dance/.test(n)) return 'dance';
  if (/sangeet|music|song/.test(n)) return 'music';
  if (/kala|art|craft|draw|paint/.test(n)) return 'arts';
  if (/sahitya|liter|poem|essay|story|spell/.test(n)) return 'literary';
  return null; // add-on / other → any venue
}

// ── POST /api/admin/schedule/generate-draft ──────────────────────────────────
// body: { start_date?, end_date?   (defaults to the competition window)
//         reporting_buffer_minutes?, minutes_per_participant_default?,
//         setup_minutes? }
// Venues, their availability (per-weekday hours), suitability and capacity
// come from the venue setup (PUT /venues).
router.post('/generate-draft', requireRole(...editRoles), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });

    const { start_date, end_date,
            reporting_buffer_minutes = 30,
            minutes_per_participant_default = 5,
            setup_minutes = 10,
            max_groups_per_session = 3,
            gap_minutes = 15,
            exclude_category_ids = [] } = req.body;
    const maxGroups = Math.min(3, Math.max(1, Number(max_groups_per_session) || 3));
    const excludeCategoryIds = (Array.isArray(exclude_category_ids) ? exclude_category_ids : [])
      .map(Number).filter((n) => Number.isInteger(n));

    const { rows: venueRows } = await pool.query(
      `SELECT * FROM venues WHERE year_id = $1 ORDER BY sort_order, id`, [yc.id]);
    if (!venueRows.length)
      return res.status(400).json({ error: 'Define at least one venue in the facility setup first' });

    const from = start_date || yc.event_start_date;
    const to = end_date || yc.event_end_date;
    if (!from || !to)
      return res.status(400).json({ error: 'Set the competition start/end dates (Year Setup) or pass start_date/end_date' });
    const days = dateRange(from, to);

    // Per date: one block per available venue (its own hours that weekday)
    const dailySlots = [];
    for (const date of days) {
      const weekday = WEEKDAYS[new Date(`${date}T12:00:00`).getDay()];
      const blocks = [];
      for (const v of venueRows) {
        const h = (v.weekday_hours || {})[weekday];
        const blocked = (v.blocked_dates || []).some((d) => localISO(d) === date);
        if (h?.start && h?.end && !blocked) blocks.push({ start: h.start, end: h.end, venues: [v.name] });
      }
      if (blocks.length) dailySlots.push({ date, blocks });
    }
    if (!dailySlots.length)
      return res.status(400).json({ error: 'No venue is available on any day in the window — check the venues\' weekday availability' });

    const config = {
      reportingBufferMinutes: Number(reporting_buffer_minutes) || 30,
      gapMinutes: Number.isFinite(Number(gap_minutes)) ? Number(gap_minutes) : 15,
      dailySlots,
    };

    // Rows that SURVIVE a regenerate (locked, or already confirmed/completed) are
    // seeded as FIXED bookings so new events are placed around them and never
    // clash with them. (Only plain unlocked DRAFT rows are replaced.)
    const { rows: lockedRows } = await pool.query(
      `SELECT s.event_id, s.age_groups,
              to_char(s.event_date, 'YYYY-MM-DD') AS date,
              to_char(s.start_time, 'HH24:MI') AS start_time,
              to_char(s.end_time, 'HH24:MI') AS end_time,
              s.venue, COALESCE(c.name, 'Other') AS category
         FROM schedule s
         LEFT JOIN events e2 ON e2.id = s.event_id
         LEFT JOIN categories c ON c.id = e2.category_id
        WHERE s.year_id = $1 AND (s.is_locked = TRUE OR s.status <> 'draft' OR s.looks_good = TRUE)`, [yc.id]);
    const lockedKeys = new Set();
    const fixedBookings = [];
    for (const lr of lockedRows) {
      const codes = (lr.age_groups || '').split(', ').filter(Boolean);
      for (const code of codes) lockedKeys.add(`${lr.event_id}:${code}`);
      const { rows: prows } = await pool.query(
        `SELECT DISTINCT COALESCE(r.participant_id, tm.participant_id) AS pid
           FROM registrations r
           LEFT JOIN team_members tm ON tm.team_id = r.team_id
           LEFT JOIN age_groups ag ON ag.id = r.age_group_id
          WHERE r.event_id = $1 AND r.status NOT IN ('withdrawn','swapped')
            AND (cardinality($2::text[]) = 0 OR ag.code = ANY($2::text[]))
            AND COALESCE(r.participant_id, tm.participant_id) IS NOT NULL`,
        [lr.event_id, codes]);
      if (lr.start_time && lr.end_time && lr.venue) {
        fixedBookings.push({
          date: lr.date, venue: lr.venue,
          start: lr.start_time, end: lr.end_time,
          event_id: lr.event_id, category: lr.category,
          participantIds: prows.map((x) => x.pid),
        });
      }
    }
    config.lockedKeys = lockedKeys;
    config.fixedBookings = fixedBookings;

    // Suitability + capacity → allowed venues per event.
    // NOTE: capacity only excludes a venue for STAGE events (audience seats
    // irrelevant); for simultaneous events (arts/literary) capacity instead
    // determines how many SESSIONS are needed, so low-capacity venues stay
    // allowed.
    const venueFor = (categoryName, isStage) => {
      const tag = categoryTag(categoryName);
      return venueRows
        .filter((v) => !tag || !v.suitable_for?.length || v.suitable_for.includes(tag))
        .filter((v) => !isStage || v.has_stage)
        .map((v) => v.name);
    };

    /**
     * Duration of ONE session for `count` entries:
     *  - STAGE events perform sequentially: count × per-participant time.
     *  - NON-STAGE events work SIMULTANEOUSLY: one sitting of the allotted
     *    time (default 60 min), split into consecutive sittings when count
     *    exceeds the best allowed venue's capacity.
     */
    const durationFor = (r, allowed, count) => {
      if (r.is_stage_event) {
        const perMin = r.allotted_time_seconds
          ? r.allotted_time_seconds / 60 : Number(minutes_per_participant_default);
        return Math.max(20, Math.ceil(count * perMin) + Number(setup_minutes));
      }
      const caps = venueRows
        .filter((v) => allowed.includes(v.name))
        .map((v) => (v.capacity == null ? Infinity : v.capacity));
      const bestCap = caps.length ? Math.max(...caps) : Infinity;
      const sessions = bestCap === Infinity ? 1 : Math.max(1, Math.ceil(count / bestCap));
      const perSession = r.allotted_time_seconds ? Math.ceil(r.allotted_time_seconds / 60) : 60;
      return Math.max(20, sessions * perSession + Number(setup_minutes));
    };

    const blockMinutesOf = (h) => {
      const [sh, sm] = h.start.split(':').map(Number);
      const [eh, em] = h.end.split(':').map(Number);
      return (eh * 60 + em) - (sh * 60 + sm);
    };
    // All available block lengths (minutes) across the allowed venues' weekday
    // hours — one entry per configured weekday per venue.
    const blockLengthsFor = (allowed) => {
      const lens = [];
      for (const v of venueRows) {
        if (!allowed.includes(v.name)) continue;
        for (const h of Object.values(v.weekday_hours || {})) {
          const m = blockMinutesOf(h);
          if (m > 0) lens.push(m);
        }
      }
      return lens;
    };
    // Longest block anywhere — used to decide whether a SINGLE group can ever
    // fit at all. Never used to justify clubbing multiple groups.
    const longestSessionFor = (allowed) => {
      const lens = blockLengthsFor(allowed);
      return lens.length ? Math.max(...lens) : 0;
    };
    // Typical (median) block — the target a COMBINED batch must fit. Prevents
    // clubbing 2–3 groups just because one rare all-day block exists; combos
    // only form when they fit a block that's actually common across the schedule.
    const typicalSessionFor = (allowed) => {
      const lens = blockLengthsFor(allowed).sort((a, b) => a - b);
      if (!lens.length) return 0;
      const mid = Math.floor(lens.length / 2);
      return lens.length % 2 ? lens[mid] : Math.min(lens[mid - 1], lens[mid]);
    };

    // Adapter between the scheduler service and the real schema
    const db = {
      // SCHEDULING UNITS = event × age-group BATCH (max ${maxGroups}
      // consecutive groups combined, and only while the batch still fits the
      // longest available session — judges handle 2–3 groups in one sitting).
      // Unit ids are synthetic '<eventId>|<G1,G2>' strings; participants and
      // saved rows are mapped back through them.
      async getActiveEventsForYear(yearId) {
        const { rows } = await pool.query(
          `SELECT e.id AS event_id, COALESCE(c.name, 'Other') AS category,
                  e.allotted_time_seconds, e.is_stage_event,
                  e.keep_groups_together, e.requires_tables,
                  pv.name AS preferred_venue,
                  c.not_before_date,
                  ag.code AS ag_code, ag.sort_order AS ag_sort,
                  COUNT(r.id)::int AS entries
           FROM events e
           LEFT JOIN categories c ON c.id = e.category_id
           LEFT JOIN venues pv ON pv.id = e.preferred_venue_id
           JOIN registrations r ON r.event_id = e.id
             AND r.status NOT IN ('withdrawn','swapped')
           LEFT JOIN participants pr ON pr.id = r.participant_id
           LEFT JOIN age_groups ag ON ag.id = r.age_group_id
           WHERE e.year_id = $1 AND e.is_cancelled = FALSE
             AND (pr.confirmed_at IS NOT NULL OR r.team_id IS NOT NULL)
             AND (e.category_id IS NULL OR e.category_id <> ALL($2::int[]))
           GROUP BY e.id, c.name, c.not_before_date, pv.name, ag.code, ag.sort_order
           ORDER BY e.id, ag.sort_order`, [yearId, excludeCategoryIds]);

        // group rows per event, then batch consecutive age groups
        const perEvent = new Map();
        for (const r of rows) {
          if (!perEvent.has(r.event_id)) perEvent.set(r.event_id, { meta: r, groups: [] });
          perEvent.get(r.event_id).groups.push({ code: r.ag_code || '—', entries: r.entries });
        }

        // Order allowed venues so a soft-pinned preferred venue is tried first
        // (the service falls back to the rest if it can't fit — reported).
        const orderByPreference = (allowed, preferred) => {
          if (!preferred || !allowed.includes(preferred)) return allowed;
          return [preferred, ...allowed.filter((v) => v !== preferred)];
        };
        // localISO for the not_before_date (avoid +03 toISOString day shift)
        const notBeforeISO = (d) => (d ? new Date(d).toLocaleDateString('en-CA') : null);

        const units = [];
        for (const { meta, groups } of perEvent.values()) {
          const baseAllowed = venueFor(meta.category, meta.is_stage_event);
          const allowed = orderByPreference(baseAllowed, meta.preferred_venue);
          const notBefore = notBeforeISO(meta.not_before_date);

          // Fields shared by every unit this event produces.
          const common = {
            real_event_id: meta.event_id,
            category: meta.category,
            allowed_venues: allowed,
            is_stage_event: meta.is_stage_event,
            preferred_venue: meta.preferred_venue || null,
            table_event: !!meta.requires_tables,
            not_before: notBefore,          // service must not place before this
          };

          // (A) KEEP-TOGETHER — all age groups run as ONE continuous block in
          // one venue (ramp/setup reuse). Overrides the split limit entirely.
          if (meta.keep_groups_together) {
            const count = groups.reduce((t, g) => t + g.entries, 0);
            const codes = groups.map((g) => g.code).join(', ');
            units.push({
              ...common,
              event_id: `${meta.event_id}|${codes}`,
              age_groups: codes,
              participant_count: count,
              duration_minutes: durationFor(meta, allowed, count),
              keep_together: true,
            });
            continue;
          }

          // (B) TABLE EVENT — one seated sitting for ALL age groups together
          // (they write/draw simultaneously; the concurrent-table pass then
          // spreads them across venues at a shared start time).
          if (meta.requires_tables) {
            const count = groups.reduce((t, g) => t + g.entries, 0);
            const codes = groups.map((g) => g.code).join(', ');
            units.push({
              ...common,
              event_id: `${meta.event_id}|${codes}`,
              age_groups: codes,
              participant_count: count,
              duration_minutes: durationFor(meta, allowed, count),
            });
            continue;
          }

          // (C) DEFAULT — split per age group, combine consecutive groups only
          // while the combined sitting fits a TYPICAL (median) block.
          const combineLimit = typicalSessionFor(allowed) || Infinity;
          let batch = [];
          const flush = () => {
            if (!batch.length) return;
            const count = batch.reduce((t, g) => t + g.entries, 0);
            const codes = batch.map((g) => g.code).join(', ');
            units.push({
              ...common,
              event_id: `${meta.event_id}|${codes}`,
              age_groups: codes,
              participant_count: count,
              duration_minutes: durationFor(meta, allowed, count),
            });
            batch = [];
          };
          for (const g of groups) {
            if (batch.length) {
              const tryCount = batch.reduce((t, x) => t + x.entries, 0) + g.entries;
              const tryDur = durationFor(meta, allowed, tryCount);
              if (batch.length >= maxGroups || tryDur > combineLimit) flush();
            }
            batch.push(g);
            const soloDur = durationFor(meta, allowed, g.entries);
            if (batch.length === 1 && soloDur > combineLimit) flush();
          }
          flush();
        }
        return units;
      },
      async getEventParticipants(yearId) {
        // participants keyed by the synthetic UNIT id (event + their group)
        const { rows } = await pool.query(
          `SELECT r.event_id, ag.code AS ag_code,
                  COALESCE(r.participant_id, tm.participant_id) AS participant_id
           FROM registrations r
           LEFT JOIN team_members tm ON tm.team_id = r.team_id
           LEFT JOIN age_groups ag ON ag.id = r.age_group_id
           WHERE r.year_id = $1 AND r.status NOT IN ('withdrawn','swapped')
             AND COALESCE(r.participant_id, tm.participant_id) IS NOT NULL`, [yearId]);
        const units = await this.getActiveEventsForYear(yearId);
        const unitFor = new Map(); // `${eventId}:${code}` → unit id
        for (const u of units)
          for (const code of u.age_groups.split(', '))
            unitFor.set(`${u.real_event_id}:${code}`, u.event_id);
        return rows
          .map((r) => ({
            event_id: unitFor.get(`${r.event_id}:${r.ag_code || '—'}`),
            participant_id: r.participant_id,
          }))
          .filter((r) => r.event_id);
      },
      async saveScheduleDraft(yearId, draft) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`DELETE FROM schedule WHERE year_id = $1 AND status = 'draft' AND is_locked = FALSE AND looks_good = FALSE`, [yearId]);
          for (const s of draft.scheduled) {
            const [realId, groups] = String(s.event_id).split('|');
            await client.query(
              `INSERT INTO schedule (year_id, event_id, event_date, start_time, end_time, venue,
                                     age_groups, status, generated_by_scheduler)
               VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',TRUE)`,
              [yearId, Number(realId), s.date, s.start_time, s.end_time, s.venue, groups || null]);
          }
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK').catch(() => null);
          throw e;
        } finally { client.release(); }
      },
    };

    const units = await db.getActiveEventsForYear(yc.id);
    const eventById = new Map(units.map((e) => [e.event_id, e]));
    const { rows: nameRows } = await pool.query(
      `SELECT id, event_code, event_name FROM events WHERE year_id = $1`, [yc.id]);
    const names = new Map(nameRows.map((n) => [n.id, n]));

    const draft = await generateScheduleDraft(yc.id, config, db);

    // Human diagnostics: WHY couldn't each event be placed?
    const venueHasDays = (name) => {
      const v = venueRows.find((x) => x.name === name);
      return v && Object.keys(v.weekday_hours || {}).length > 0;
    };
    const longestBlockFor = (allowed) => {
      let best = 0, bestVenue = null;
      for (const v of venueRows) {
        if (!allowed.includes(v.name)) continue;
        for (const h of Object.values(v.weekday_hours || {})) {
          const m = blockMinutesOf(h);
          if (m > best) { best = m; bestVenue = v.name; }
        }
      }
      return { best, bestVenue };
    };

    const unplaced = draft.unplaced.map((u) => {
      const ev = eventById.get(u.event_id);
      const nm = names.get(ev?.real_event_id ?? u.event_id) || {};
      let reason;
      if (!ev || !ev.allowed_venues.length) {
        reason = 'No suitable venue (check category suitability / stage requirement in the venue setup)';
      } else if (!ev.allowed_venues.some(venueHasDays)) {
        reason = `Suitable venue(s) ${ev.allowed_venues.join(', ')} have NO availability days configured`;
      } else {
        const { best, bestVenue } = longestBlockFor(ev.allowed_venues);
        if (ev.duration_minutes > best) {
          reason = `Needs ~${ev.duration_minutes} min (${ev.participant_count} entries, ` +
            `${ev.is_stage_event ? 'sequential stage performances' : 'simultaneous sessions'}) ` +
            `but the longest available session is ${best} min at ${bestVenue} — extend hours, add days or venues`;
        } else {
          reason = 'No conflict-free slot left in the window (participants clash or sessions full) — add days/venues';
        }
      }
      return { event_id: ev?.real_event_id ?? u.event_id,
               event_code: nm.event_code,
               event_name: nm.event_name + (ev?.age_groups ? ` [${ev.age_groups}]` : ''),
               entries: ev?.participant_count ?? null, needed_minutes: ev?.duration_minutes ?? null,
               reason };
    });

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'GENERATE_DRAFT_SCHEDULE', entity: 'schedule', entityId: yc.id,
      details: { scheduled: draft.scheduled.length, unplaced: unplaced.length,
                 venues: venueRows.map((v) => v.name), days: days.length } });

    res.json({ scheduled: draft.scheduled.length, unplaced });
  } catch (err) { next(err); }
});

// ── GET /api/admin/schedule ───────────────────────────────────────────────────
router.get('/', requireRole(...staffRoles, 'Media'), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.json([]);
    const { rows } = await pool.query(
      `SELECT s.id, to_char(s.event_date, 'YYYY-MM-DD') AS event_date,
              s.start_time, s.end_time, s.venue, s.status, s.generated_by_scheduler,
              s.event_id, s.time_slot_id, s.age_groups, s.is_locked, s.looks_good,
              to_char(s.locked_at, 'YYYY-MM-DD') AS locked_at,
              e.event_code, e.event_name, e.event_kind, c.name AS category_name, c.code AS category_code,
              e.allotted_time_seconds, e.is_stage_event,
              (SELECT COUNT(*)::int FROM registrations r
               LEFT JOIN participants pr2 ON pr2.id = r.participant_id
               LEFT JOIN age_groups ag2 ON ag2.id = r.age_group_id
               WHERE r.event_id = e.id AND r.status NOT IN ('withdrawn','swapped')
                 AND (pr2.confirmed_at IS NOT NULL OR r.team_id IS NOT NULL)
                 AND (s.age_groups IS NULL OR ag2.code = ANY(string_to_array(s.age_groups, ', ')))) AS entries,
              (SELECT json_agg(json_build_object('code', g.code, 'entries', g.cnt) ORDER BY g.sort_order)
               FROM (SELECT ag3.code, ag3.sort_order, COUNT(*)::int AS cnt
                     FROM registrations r3
                     JOIN age_groups ag3 ON ag3.id = r3.age_group_id
                     LEFT JOIN participants pr3 ON pr3.id = r3.participant_id
                     WHERE r3.event_id = e.id AND r3.status NOT IN ('withdrawn','swapped')
                       AND (pr3.confirmed_at IS NOT NULL OR r3.team_id IS NOT NULL)
                       AND (s.age_groups IS NULL OR ag3.code = ANY(string_to_array(s.age_groups, ', ')))
                     GROUP BY ag3.code, ag3.sort_order) g) AS groups
       FROM schedule s
       JOIN events e ON e.id = s.event_id
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE s.year_id = $1
       ORDER BY s.event_date, s.start_time, s.venue`, [yc.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── PUT /api/admin/schedule/:id ───────────────────────────────────────────────
router.put('/:id', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { event_date, start_time, end_time, venue } = req.body;
    const { rows: before } = await pool.query(
      `SELECT event_date, start_time, end_time, venue FROM schedule WHERE id = $1`, [req.params.id]);
    if (!before[0]) return res.status(404).json({ error: 'Schedule row not found' });

    const { rows } = await pool.query(
      `UPDATE schedule SET
         event_date = COALESCE($1, event_date),
         start_time = COALESCE($2, start_time),
         end_time = COALESCE($3, end_time),
         venue = COALESCE($4, venue),
         generated_by_scheduler = FALSE,
         updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [event_date || null, start_time || null, end_time || null, venue || null, req.params.id]);

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'EDIT_SCHEDULE_ROW', entity: 'schedule', entityId: req.params.id,
      before: before[0],
      details: { event_date: rows[0].event_date, start_time: rows[0].start_time,
                 end_time: rows[0].end_time, venue: rows[0].venue } });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/admin/schedule/clear-drafts ────────────────────────────────────
// Delete ALL draft, unlocked rows for the active year (keeps locked + confirmed).
router.post('/clear-drafts', requireRole(...editRoles), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });
    const { rows } = await pool.query(
      `DELETE FROM schedule WHERE year_id = $1 AND status = 'draft' AND is_locked = FALSE AND looks_good = FALSE RETURNING id`, [yc.id]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'CLEAR_SCHEDULE_DRAFTS', entity: 'schedule', entityId: yc.id, details: { cleared: rows.length } });
    res.json({ cleared: rows.length });
  } catch (err) { next(err); }
});

// ── POST /api/admin/schedule/:id/state ───────────────────────────────────────
// Per-row review toggle: 'draft' -> 'looks_good' -> 'locked'.
router.post('/:id/state', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { state } = req.body;
    if (!['draft', 'looks_good', 'locked'].includes(state))
      return res.status(400).json({ error: "state must be 'draft', 'looks_good' or 'locked'" });
    let result;
    if (state === 'locked')
      result = await pool.query(
        `UPDATE schedule SET is_locked = TRUE, looks_good = TRUE, locked_at = NOW(), locked_by = $2, updated_at = NOW()
          WHERE id = $1 RETURNING id`, [req.params.id, req.user.id]);
    else if (state === 'looks_good')
      result = await pool.query(
        `UPDATE schedule SET looks_good = TRUE, is_locked = FALSE, locked_at = NULL, locked_by = NULL, updated_at = NOW()
          WHERE id = $1 RETURNING id`, [req.params.id]);
    else
      result = await pool.query(
        `UPDATE schedule SET looks_good = FALSE, is_locked = FALSE, locked_at = NULL, locked_by = NULL, updated_at = NOW()
          WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Schedule row not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'SCHEDULE_ROW_STATE', entity: 'schedule', entityId: req.params.id, details: { state } });
    res.json({ ok: true, state });
  } catch (err) { next(err); }
});

// ── POST /api/admin/schedule/:id/remove-group ────────────────────────────────
// Drop one age group from an event's scheduled row. If it was the last group,
// the whole row is removed.
router.post('/:id/remove-group', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'code is required' });
    const { rows } = await pool.query(`SELECT age_groups FROM schedule WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Schedule row not found' });
    const codes = (rows[0].age_groups || '').split(', ').filter(Boolean).filter((c) => c !== code);
    if (!codes.length) {
      await pool.query(`DELETE FROM schedule WHERE id = $1`, [req.params.id]);
      await logAudit({ actorId: req.user.id, actorRole: req.user.role,
        action: 'REMOVE_SCHEDULE_GROUP', entity: 'schedule', entityId: req.params.id,
        details: { code, row_deleted: true } });
      return res.json({ deleted: true });
    }
    await pool.query(
      `UPDATE schedule SET age_groups = $2, generated_by_scheduler = FALSE, updated_at = NOW() WHERE id = $1`,
      [req.params.id, codes.join(', ')]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'REMOVE_SCHEDULE_GROUP', entity: 'schedule', entityId: req.params.id,
      details: { code, age_groups: codes.join(', ') } });
    res.json({ age_groups: codes.join(', ') });
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/schedule/:id ───────────────────────────────────────────
// Drop an event from the schedule (remove the row).
router.delete('/:id', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM schedule WHERE id = $1
       RETURNING event_id, age_groups, to_char(event_date,'YYYY-MM-DD') AS event_date, is_locked`,
      [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Schedule row not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'DROP_SCHEDULE_ROW', entity: 'schedule', entityId: req.params.id, before: rows[0] });
    res.json({ dropped: true });
  } catch (err) { next(err); }
});

// ── POST /api/admin/schedule/:id/check-move ──────────────────────────────────
// Dry-run a move: would placing THIS event at the given date/time break a rule?
// Returns { warnings: [...] } (participant clash, >2 events/day, venue clash).
const partsOfQuery =
  `SELECT DISTINCT COALESCE(r.participant_id, tm.participant_id) AS pid
     FROM registrations r
     LEFT JOIN team_members tm ON tm.team_id = r.team_id
     LEFT JOIN age_groups ag ON ag.id = r.age_group_id
    WHERE r.event_id = $1 AND r.status NOT IN ('withdrawn','swapped')
      AND (cardinality($2::text[]) = 0 OR ag.code = ANY($2::text[]))
      AND COALESCE(r.participant_id, tm.participant_id) IS NOT NULL`;
const codesOf = (ag) => (ag || '').split(', ').filter(Boolean);
const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };

router.post('/:id/check-move', requireRole(...editRoles), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.json({ warnings: [] });
    const { event_date, start_time, end_time, venue } = req.body;
    if (!event_date || !start_time || !end_time) return res.json({ warnings: [] });

    const { rows: me } = await pool.query(
      `SELECT event_id, age_groups FROM schedule WHERE id = $1`, [req.params.id]);
    if (!me[0]) return res.status(404).json({ error: 'Schedule row not found' });

    const { rows: myP } = await pool.query(partsOfQuery, [me[0].event_id, codesOf(me[0].age_groups)]);
    const mySet = new Set(myP.map((x) => x.pid));

    const { rows: others } = await pool.query(
      `SELECT s.id, s.event_id, s.age_groups, s.venue,
              to_char(s.start_time,'HH24:MI') AS st, to_char(s.end_time,'HH24:MI') AS en,
              e.event_code, e.event_name
         FROM schedule s JOIN events e ON e.id = s.event_id
        WHERE s.year_id = $1 AND s.event_date = $2 AND s.id <> $3`,
      [yc.id, event_date, req.params.id]);

    const ns = toMin(start_time), ne = toMin(end_time);
    const warnings = [];
    const perChild = {}; // pid -> count of OTHER events that child has this date
    for (const o of others) {
      const { rows: oP } = await pool.query(partsOfQuery, [o.event_id, codesOf(o.age_groups)]);
      const oSet = new Set(oP.map((x) => x.pid));
      const shared = [...mySet].filter((pid) => oSet.has(pid));
      shared.forEach((pid) => { perChild[pid] = (perChild[pid] || 0) + 1; });
      const os = toMin(o.st), oe = toMin(o.en);
      if (shared.length && ns < oe && os < ne)
        warnings.push(`${shared.length} participant(s) are also in ${o.event_code} ${o.event_name} (${o.st}–${o.en}) at the same time.`);
      if (venue && o.venue === venue && ns < oe && os < ne)
        warnings.push(`${venue} is already booked for ${o.event_code} ${o.event_name} (${o.st}–${o.en}).`);
    }
    const over = Object.values(perChild).filter((c) => c >= 2).length;
    if (over > 0) warnings.push(`${over} participant(s) would then have more than 2 events on ${event_date}.`);

    res.json({ warnings });
  } catch (err) { next(err); }
});

// ── POST /api/admin/schedule/publish ─────────────────────────────────────────
router.post('/publish', requireRole('SuperAdmin', 'Admin', 'Chairman'), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });
    const { rows } = await pool.query(
      `UPDATE schedule SET status = 'confirmed', updated_at = NOW()
       WHERE year_id = $1 AND status = 'draft' RETURNING id`, [yc.id]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'PUBLISH_SCHEDULE', entity: 'schedule', entityId: yc.id,
      details: { confirmed_rows: rows.length } });
    res.json({ confirmed: rows.length });
  } catch (err) { next(err); }
});

// ── POST /api/admin/schedule/lock ────────────────────────────────────────────
// Lock the current (unlocked) placements as a committed phase. Locked rows are
// never moved or regenerated by a later generate-draft; the next phase is built
// around them. Separate from publish.
router.post('/lock', requireRole('SuperAdmin', 'Admin', 'Chairman'), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });
    const { rows } = await pool.query(
      `UPDATE schedule SET is_locked = TRUE, locked_at = NOW(), locked_by = $2, updated_at = NOW()
        WHERE year_id = $1 AND is_locked = FALSE RETURNING id`, [yc.id, req.user.id]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'LOCK_SCHEDULE_PHASE', entity: 'schedule', entityId: yc.id,
      details: { locked: rows.length } });
    res.json({ locked: rows.length });
  } catch (err) { next(err); }
});

// ── POST /api/admin/schedule/unlock ──────────────────────────────────────────
// Unlock all locked rows so a phase can be regenerated. Does not delete them.
router.post('/unlock', requireRole('SuperAdmin', 'Admin', 'Chairman'), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });
    const { rows } = await pool.query(
      `UPDATE schedule SET is_locked = FALSE, locked_at = NULL, locked_by = NULL, updated_at = NOW()
        WHERE year_id = $1 AND is_locked = TRUE RETURNING id`, [yc.id]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'UNLOCK_SCHEDULE_PHASE', entity: 'schedule', entityId: yc.id,
      details: { unlocked: rows.length } });
    res.json({ unlocked: rows.length });
  } catch (err) { next(err); }
});

module.exports = router;

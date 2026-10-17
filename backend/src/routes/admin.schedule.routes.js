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

// A published (confirmed/completed) row is locked against edits for everyone
// except the SuperAdmin. Returns true if the row exists and is published.
async function rowPublished(id) {
  const { rows } = await pool.query(`SELECT status FROM schedule WHERE id = $1`, [id]);
  return !!rows[0] && (rows[0].status === 'confirmed' || rows[0].status === 'completed');
}
const PUBLISHED_GUARD = 'This row is already published — only the SuperAdmin can change it.';

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

    // Re-flow mode: when the office has fixed a few things and regenerates, only
    // re-place the events that currently have plain DRAFT rows — do NOT pull in
    // new/removed events the scheduler would otherwise find "suitable". null =
    // normal full generate (every eligible event).
    let restrictEventIds = null;
    if (req.body?.reflow_only) {
      const { rows: dr } = await pool.query(
        `SELECT DISTINCT event_id FROM schedule
          WHERE year_id = $1 AND status = 'draft' AND is_locked = FALSE AND looks_good = FALSE`, [yc.id]);
      restrictEventIds = dr.map((r) => r.event_id);
      if (restrictEventIds.length === 0) restrictEventIds = [-1]; // nothing to re-flow
    }

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
             AND ($3::int[] IS NULL OR e.id = ANY($3::int[]))
           GROUP BY e.id, c.name, c.not_before_date, pv.name, ag.code, ag.sort_order
           ORDER BY e.id, ag.sort_order`, [yearId, excludeCategoryIds, restrictEventIds]);

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
    if (req.user.role !== 'SuperAdmin' && await rowPublished(req.params.id))
      return res.status(403).json({ error: PUBLISHED_GUARD });
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
    if (req.user.role !== 'SuperAdmin' && await rowPublished(req.params.id))
      return res.status(403).json({ error: PUBLISHED_GUARD });
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

// ── GET /api/admin/schedule/full-report?from=&to= ────────────────────────────
// Whole-schedule Excel: one row per event x group, with Date, Start-End, Venue,
// Event, Group, Duration (group's total time), Reporting time and # participants.
// Sorted by Date, Venue, Time. Optional from/to date range (default all).
router.get('/full-report', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    const from = ymd.test(req.query.from || '') ? req.query.from : null;
    const to = ymd.test(req.query.to || '') ? req.query.to : null;

    const { rows } = await pool.query(
      `SELECT s.id AS sched_id, to_char(s.event_date,'YYYY-MM-DD') AS event_date,
              to_char(s.event_date,'Dy') AS dow, s.venue, s.status,
              to_char(s.start_time,'HH24:MI') AS start_time, to_char(s.end_time,'HH24:MI') AS end_time,
              e.event_code, e.event_name, e.is_stage_event, e.allotted_time_seconds,
              ag.code AS gcode, ag.label AS glabel, ag.sort_order AS gsort,
              (SELECT COUNT(*) FROM registrations r
                 LEFT JOIN participants pr ON pr.id = r.participant_id
                WHERE r.event_id = e.id AND r.status NOT IN ('withdrawn','swapped')
                  AND (pr.confirmed_at IS NOT NULL OR r.team_id IS NOT NULL)
                  AND r.age_group_id = ag.id) AS cnt
         FROM schedule s JOIN events e ON e.id = s.event_id
         JOIN age_groups ag ON ag.year_id = s.year_id
              AND ag.code = ANY(string_to_array(s.age_groups, ', '))
        WHERE s.year_id = $1
          AND ($2::date IS NULL OR s.event_date >= $2::date)
          AND ($3::date IS NULL OR s.event_date <= $3::date)
        ORDER BY s.event_date NULLS LAST, s.venue, s.start_time NULLS LAST, s.id, ag.sort_order NULLS LAST, ag.code`,
      [yc.id, from, to]);

    const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };

    // staggered reporting per (sched row, group)
    const meta = new Map();
    for (const r of rows) {
      if (!meta.has(r.sched_id)) meta.set(r.sched_id, {
        start: r.start_time ? toMin(r.start_time) : null,
        perMin: r.allotted_time_seconds ? r.allotted_time_seconds / 60 : 5,
        isStage: r.is_stage_event, order: [] });
      meta.get(r.sched_id).order.push({ code: r.gcode, cnt: Number(r.cnt) || 0 });
    }
    const repMap = new Map();
    for (const [sid, m] of meta) {
      if (m.start == null) { m.order.forEach((g) => repMap.set(`${sid}|${g.code}`, null)); continue; }
      if (!m.isStage || m.order.length <= 1) { m.order.forEach((g) => repMap.set(`${sid}|${g.code}`, m.start - 15)); continue; }
      let ps = m.start;
      m.order.forEach((g, i) => { repMap.set(`${sid}|${g.code}`, i === 0 ? m.start - 15 : ps - 30); ps += Math.ceil(g.cnt * m.perMin); });
    }

    // 12-hour dotted time, e.g. 6.50pm (the format used on parent notices)
    const fmt12 = (min) => {
      if (min == null) return '';
      const x = ((min % 1440) + 1440) % 1440;
      let hh = Math.floor(x / 60); const mm = x % 60;
      const ap = hh < 12 ? 'am' : 'pm'; hh = hh % 12; if (hh === 0) hh = 12;
      return `${hh}.${String(mm).padStart(2, '0')}${ap}`;
    };

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); wb.creator = 'KCA ITS'; wb.created = new Date();

    // Column order matches the notice sent to parents, then helper columns.
    const addSheet = (name, subset) => {
      const ws = wb.addWorksheet(name);
      ws.columns = [
        { header: 'Date', key: 'date', width: 10 },
        { header: 'Day', key: 'day', width: 6 },
        { header: 'Event', key: 'event', width: 32 },
        { header: 'Group', key: 'group', width: 7 },
        { header: 'Time Allowed', key: 'allowed', width: 13 },
        { header: 'Reporting Time', key: 'rep', width: 14 },
        { header: 'Venue', key: 'venue', width: 16 },
        { header: 'Participants', key: 'cnt', width: 12 },
        { header: 'Start', key: 'start', width: 8 },
        { header: 'End', key: 'end', width: 8 },
      ];
      for (const r of subset) {
        const cnt = Number(r.cnt) || 0;
        const per = r.allotted_time_seconds ? Math.round(r.allotted_time_seconds / 60) : null;
        ws.addRow({
          date: r.event_date || '', day: r.dow || '', event: r.event_name, group: r.gcode,
          allowed: per != null ? `${per} min.` : '',
          rep: fmt12(repMap.get(`${r.sched_id}|${r.gcode}`)),
          venue: r.venue || '', cnt,
          start: r.start_time || '', end: r.end_time || '',
        });
      }
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      ws.autoFilter = { from: 'A1', to: 'J1' };
      return ws;
    };

    const published = rows.filter((r) => r.status === 'confirmed' || r.status === 'completed');
    const unpublished = rows.filter((r) => r.status === 'draft');
    addSheet('Published', published);
    addSheet('Unpublished', unpublished);

    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'EXPORT_FULL_SCHEDULE',
      entity: 'schedule', entityId: yc.id, details: { rows: rows.length, from, to } });

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="full-schedule.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) { next(err); }
});

// ── GET /api/admin/schedule/day-report?date=YYYY-MM-DD ───────────────────────
// Excel day-sheet: every participant with ALL their events on that date, their
// group's reporting time, time allowed per participant, venue and event window,
// plus a count and a flag for anyone with more than 2 events. Helps verify the
// 2-events-per-day rule and see the flow.
router.get('/day-report', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const date = req.query.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || ''))
      return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });

    const { rows: sched } = await pool.query(
      `SELECT s.id AS sched_id, s.venue, s.age_groups,
              to_char(s.start_time,'HH24:MI') AS start_time, to_char(s.end_time,'HH24:MI') AS end_time,
              e.id AS event_id, e.event_code, e.event_name, e.is_stage_event, e.allotted_time_seconds
         FROM schedule s JOIN events e ON e.id = s.event_id
        WHERE s.year_id = $1 AND s.event_date = $2
        ORDER BY s.start_time NULLS LAST, s.id`, [yc.id, date]);

    const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
    const fmt = (min) => { if (min == null) return ''; const x = ((min % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

    // participant -> { name, age, school, events: [{reporting, reportingMin, event, venue, group, perMin, window}] }
    const byPart = new Map();
    for (const row of sched) {
      const codes = (row.age_groups || '').split(', ').filter(Boolean);
      if (!codes.length) continue;
      const perMin = row.allotted_time_seconds ? row.allotted_time_seconds / 60 : 5;
      const { rows: parts } = await pool.query(
        `SELECT p.id, p.full_name, ag.code AS gcode, ag.label AS glabel, ag.sort_order AS gsort,
                sch.name AS school
           FROM registrations r
           JOIN participants p ON p.id = r.participant_id
           LEFT JOIN age_groups ag ON ag.id = r.age_group_id
           LEFT JOIN schools sch ON sch.id = p.school_id
          WHERE r.event_id = $1 AND r.status NOT IN ('withdrawn','swapped')
            AND p.confirmed_at IS NOT NULL
            AND ag.code = ANY($2::text[])
          ORDER BY ag.sort_order NULLS LAST, p.full_name`, [row.event_id, codes]);

      // ordered groups with counts, for the staggered reporting
      const counts = {};
      parts.forEach((p) => { counts[p.gcode] = (counts[p.gcode] || 0) + 1; });
      const orderedCodes = [...new Set(parts.map((p) => p.gcode))];
      const start = row.start_time ? toMin(row.start_time) : null;
      const repByGroup = {};
      if (start != null) {
        if (!row.is_stage_event || orderedCodes.length <= 1) {
          orderedCodes.forEach((c) => { repByGroup[c] = start - 15; });
        } else {
          let performStart = start;
          orderedCodes.forEach((c, i) => {
            repByGroup[c] = i === 0 ? start - 15 : performStart - 30;
            performStart += Math.ceil((counts[c] || 0) * perMin);
          });
        }
      }

      for (const p of parts) {
        if (!byPart.has(p.id)) byPart.set(p.id, { name: p.full_name, group: p.glabel, school: p.school || '', events: [] });
        byPart.get(p.id).events.push({
          reportingMin: repByGroup[p.gcode] ?? null,
          reporting: fmt(repByGroup[p.gcode]),
          event: `${row.event_code} — ${row.event_name}`,
          venue: row.venue || '',
          perMin: Math.round(perMin * 10) / 10,
          window: row.start_time ? `${row.start_time}–${row.end_time || ''}` : '',
        });
      }
    }

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); wb.creator = 'KCA ITS'; wb.created = new Date();
    const ws = wb.addWorksheet(`Day ${date}`);
    ws.columns = [
      { header: 'Participant', key: 'name', width: 26 },
      { header: 'Age Group', key: 'age', width: 12 },
      { header: 'School', key: 'school', width: 26 },
      { header: 'Events today', key: 'n', width: 12 },
      { header: 'Flag', key: 'flag', width: 10 },
      { header: 'Reporting', key: 'rep', width: 11 },
      { header: 'Event', key: 'event', width: 34 },
      { header: 'Venue', key: 'venue', width: 16 },
      { header: 'Min/participant', key: 'perMin', width: 14 },
      { header: 'Event window', key: 'window', width: 16 },
    ];

    const participants = [...byPart.values()]
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    let over = 0;
    for (const p of participants) {
      const evs = [...p.events].sort((a, b) => (a.reportingMin ?? 1e9) - (b.reportingMin ?? 1e9));
      const n = evs.length;
      if (n > 2) over += 1;
      evs.forEach((ev, i) => {
        const r = ws.addRow({
          name: i === 0 ? String(p.name || '').toUpperCase() : '',
          age: i === 0 ? p.group : '',
          school: i === 0 ? p.school : '',
          n: i === 0 ? n : '',
          flag: i === 0 ? (n > 2 ? `>2 (${n})` : '') : '',
          rep: ev.reporting, event: ev.event, venue: ev.venue,
          perMin: ev.perMin, window: ev.window,
        });
        if (n > 2) r.getCell('flag').font = { bold: true, color: { argb: 'FFB91C1C' } };
      });
    }
    const h = ws.getRow(1); h.font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: 'A1', to: 'J1' };
    ws.addRow({});
    const sum = ws.addRow({ name: `${participants.length} participant(s) scheduled on ${date}  ·  ${over} with more than 2 events` });
    sum.font = { italic: true, color: { argb: 'FF666666' } };

    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'EXPORT_DAY_SCHEDULE',
      entity: 'schedule', entityId: yc.id, details: { date, participants: participants.length, over } });

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="day-schedule-${date}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) { next(err); }
});

// ── POST /api/admin/schedule/date-state  { date, state } ─────────────────────
// Set EVERY row on one date to draft / looks_good / locked in one action, so the
// office can mark a whole day reviewed or locked without toggling each row.
router.post('/date-state', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { date, state } = req.body;
    if (!date) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
    if (!['draft', 'looks_good', 'locked'].includes(state))
      return res.status(400).json({ error: "state must be 'draft', 'looks_good' or 'locked'" });
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });
    if (req.user.role !== 'SuperAdmin') {
      const { rows: pub } = await pool.query(
        `SELECT 1 FROM schedule WHERE year_id = $1 AND event_date = $2
           AND status IN ('confirmed','completed') LIMIT 1`, [yc.id, date]);
      if (pub[0]) return res.status(403).json({ error: 'That day has published events — only the SuperAdmin can change it.' });
    }

    let sql;
    if (state === 'locked')
      sql = `UPDATE schedule SET is_locked = TRUE, looks_good = TRUE, locked_at = NOW(), locked_by = $3, updated_at = NOW()
               WHERE year_id = $1 AND event_date = $2 RETURNING id`;
    else if (state === 'looks_good')
      sql = `UPDATE schedule SET looks_good = TRUE, is_locked = FALSE, locked_at = NULL, locked_by = NULL, updated_at = NOW()
               WHERE year_id = $1 AND event_date = $2 RETURNING id`;
    else
      sql = `UPDATE schedule SET looks_good = FALSE, is_locked = FALSE, locked_at = NULL, locked_by = NULL, updated_at = NOW()
               WHERE year_id = $1 AND event_date = $2 RETURNING id`;
    const params = state === 'locked' ? [yc.id, date, req.user.id] : [yc.id, date];
    const { rows } = await pool.query(sql, params);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'SCHEDULE_DATE_STATE', entity: 'schedule', entityId: yc.id, details: { date, state, rows: rows.length } });
    res.json({ ok: true, state, date, updated: rows.length });
  } catch (err) { next(err); }
});

// ── POST /api/admin/schedule/move-date/check  { from_date, to_date } ─────────
// Dry-run a whole-day move: would any event moving to to_date clash with events
// already there? Checks participant time-overlaps, venue double-booking, and the
// 2-events-per-day-per-child rule. Returns { warnings: [...], moving }.
router.post('/move-date/check', requireRole(...editRoles), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.json({ warnings: [], moving: 0 });
    const { from_date, to_date } = req.body || {};
    if (!from_date || !to_date || from_date === to_date) return res.json({ warnings: [], moving: 0 });

    const rowSel = `SELECT s.id, s.event_id, s.age_groups, s.venue,
              to_char(s.start_time,'HH24:MI') AS st, to_char(s.end_time,'HH24:MI') AS en,
              e.event_code, e.event_name
         FROM schedule s JOIN events e ON e.id = s.event_id
        WHERE s.year_id = $1 AND s.event_date = $2`;
    const { rows: moving } = await pool.query(rowSel, [yc.id, from_date]);
    if (!moving.length) return res.json({ warnings: [], moving: 0 });
    const { rows: existing } = await pool.query(rowSel, [yc.id, to_date]);

    const cache = new Map();
    const partsOf = async (eventId, ag) => {
      const key = `${eventId}|${ag}`;
      if (cache.has(key)) return cache.get(key);
      const { rows } = await pool.query(partsOfQuery, [eventId, codesOf(ag)]);
      const set = new Set(rows.map((x) => x.pid));
      cache.set(key, set); return set;
    };

    const warnSet = new Set();
    for (const m of moving) {
      const mSet = await partsOf(m.event_id, m.age_groups);
      const ms = toMin(m.st), me = toMin(m.en);
      for (const o of existing) {
        const os = toMin(o.st), oe = toMin(o.en);
        if (!(ms < oe && os < me)) continue; // no time overlap
        const oSet = await partsOf(o.event_id, o.age_groups);
        const shared = [...mSet].filter((p) => oSet.has(p)).length;
        if (shared) warnSet.add(`${shared} participant(s): ${m.event_code} ${m.event_name} (${m.st}–${m.en}) clashes with ${o.event_code} ${o.event_name} (${o.st}–${o.en}).`);
        if (m.venue && o.venue === m.venue) warnSet.add(`Venue ${m.venue}: ${m.event_code} ${m.event_name} (${m.st}–${m.en}) overlaps ${o.event_code} ${o.event_name} (${o.st}–${o.en}).`);
      }
    }
    // 2-per-day rule across existing + moved on to_date.
    const count = {}, movedHas = {};
    for (const r of existing) { const set = await partsOf(r.event_id, r.age_groups); for (const p of set) count[p] = (count[p] || 0) + 1; }
    for (const r of moving) { const set = await partsOf(r.event_id, r.age_groups); for (const p of set) { count[p] = (count[p] || 0) + 1; movedHas[p] = true; } }
    const over = Object.keys(count).filter((p) => count[p] > 2 && movedHas[p]).length;
    if (over > 0) warnSet.add(`${over} participant(s) would have more than 2 events on ${to_date} after the move.`);

    res.json({ warnings: [...warnSet], moving: moving.length });
  } catch (err) { next(err); }
});

// ── POST /api/admin/schedule/move-date  { from_date, to_date } ───────────────
// Move EVERY row on one date to another date, as-is (same venue, start/end and
// reporting times). A whole-day shift; the office can then adjust individual
// rows. Does not re-check clashes — it is an explicit manual move.
router.post('/move-date', requireRole(...editRoles), async (req, res, next) => {
  try {
    const from = req.body?.from_date;
    const to = req.body?.to_date;
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    if (!ymd.test(from || '') || !ymd.test(to || ''))
      return res.status(400).json({ error: 'from_date and to_date are required (YYYY-MM-DD)' });
    if (from === to) return res.status(400).json({ error: 'The new date is the same as the current date' });
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });

    if (req.user.role !== 'SuperAdmin') {
      const { rows: pub } = await pool.query(
        `SELECT 1 FROM schedule WHERE year_id = $1 AND event_date = $2
           AND status IN ('confirmed','completed') LIMIT 1`, [yc.id, from]);
      if (pub[0]) return res.status(403).json({ error: 'That day has published events — only the SuperAdmin can move it.' });
    }
    const { rows } = await pool.query(
      `UPDATE schedule SET event_date = $3, generated_by_scheduler = FALSE, updated_at = NOW()
         WHERE year_id = $1 AND event_date = $2 RETURNING id`, [yc.id, from, to]);
    if (!rows.length) return res.status(404).json({ error: 'No events on that date to move' });

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'SCHEDULE_MOVE_DATE', entity: 'schedule', entityId: yc.id,
      details: { from_date: from, to_date: to, rows: rows.length } });
    res.json({ ok: true, from_date: from, to_date: to, moved: rows.length });
  } catch (err) { next(err); }
});

// ── GET /api/admin/schedule/addable ──────────────────────────────────────────
// Event x age-group cells that have confirmed entries but are NOT currently on
// the schedule — i.e. events that were removed, or that the generator could not
// place. These can be added back to a chosen date without a full regenerate.
router.get('/addable', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.json([]);
    const { rows } = await pool.query(
      `WITH cells AS (
         SELECT e.id AS event_id, e.event_code, e.event_name,
                e.is_stage_event, e.allotted_time_seconds,
                COALESCE(c.name, 'Other') AS category_name,
                ag.code AS ag_code, ag.sort_order AS ag_sort,
                COUNT(r.id)::int AS entries
           FROM events e
           LEFT JOIN categories c ON c.id = e.category_id
           JOIN registrations r ON r.event_id = e.id AND r.status NOT IN ('withdrawn','swapped')
           LEFT JOIN participants pr ON pr.id = r.participant_id
           LEFT JOIN age_groups ag ON ag.id = r.age_group_id
          WHERE e.year_id = $1 AND e.is_cancelled = FALSE
            AND (pr.confirmed_at IS NOT NULL OR r.team_id IS NOT NULL)
            AND ag.code IS NOT NULL
          GROUP BY e.id, c.name, ag.code, ag.sort_order
       )
       SELECT cc.* FROM cells cc
        WHERE NOT EXISTS (
          SELECT 1 FROM schedule s
           WHERE s.year_id = $1 AND s.event_id = cc.event_id
             AND cc.ag_code = ANY(string_to_array(s.age_groups, ', '))
        )
        ORDER BY cc.event_code, cc.ag_sort`, [yc.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/admin/schedule/add-row ─────────────────────────────────────────
// Manually add ONE unscheduled event x age-group cell to the schedule at a given
// date / venue / start time, as a draft row. End time is estimated from the
// entries; the office can fine-tune with Adjust.
router.post('/add-row', requireRole(...editRoles), async (req, res, next) => {
  try {
    const eventId = Number(req.body?.event_id);
    const code = String(req.body?.age_group_code || '').trim();
    const date = req.body?.event_date;
    const venue = String(req.body?.venue || '').trim();
    const start = String(req.body?.start_time || '').trim();
    const ymd = /^\d{4}-\d{2}-\d{2}$/, hm = /^\d{2}:\d{2}$/;
    if (!eventId || !code || !ymd.test(date || '') || !venue || !hm.test(start))
      return res.status(400).json({ error: 'event_id, age_group_code, event_date (YYYY-MM-DD), venue and start_time (HH:MM) are required' });
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });

    const { rows: ev } = await pool.query(
      `SELECT e.id, e.is_stage_event, e.allotted_time_seconds,
              (SELECT COUNT(*)::int FROM registrations r
                 LEFT JOIN participants pr ON pr.id = r.participant_id
                 LEFT JOIN age_groups ag ON ag.id = r.age_group_id
                WHERE r.event_id = e.id AND r.status NOT IN ('withdrawn','swapped')
                  AND (pr.confirmed_at IS NOT NULL OR r.team_id IS NOT NULL)
                  AND ag.code = $2) AS entries
         FROM events e WHERE e.id = $1 AND e.year_id = $3 AND e.is_cancelled = FALSE`,
      [eventId, code, yc.id]);
    if (!ev[0]) return res.status(404).json({ error: 'Event not found' });

    // Already scheduled for this cell? Don't duplicate.
    const { rows: dup } = await pool.query(
      `SELECT 1 FROM schedule WHERE year_id = $1 AND event_id = $2
         AND $3 = ANY(string_to_array(age_groups, ', ')) LIMIT 1`, [yc.id, eventId, code]);
    if (dup[0]) return res.status(409).json({ error: 'That event and group is already on the schedule.' });

    const entries = Math.max(1, Number(ev[0].entries) || 1);
    const perMin = ev[0].allotted_time_seconds ? ev[0].allotted_time_seconds / 60 : 5;
    const minutes = Math.max(20, Math.ceil(entries * perMin) + 10);
    const [hh, mm] = start.split(':').map(Number);
    const endMins = hh * 60 + mm + minutes;
    const end = `${String(Math.floor(endMins / 60) % 24).padStart(2, '0')}:${String(endMins % 60).padStart(2, '0')}`;

    const { rows: ins } = await pool.query(
      `INSERT INTO schedule (year_id, event_id, event_date, start_time, end_time, venue,
                             age_groups, status, generated_by_scheduler)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',FALSE) RETURNING id`,
      [yc.id, eventId, date, start, end, venue, code]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'SCHEDULE_ADD_ROW', entity: 'schedule', entityId: ins[0].id,
      details: { event_id: eventId, age_group_code: code, event_date: date, venue, start_time: start, end_time: end } });
    res.json({ ok: true, id: ins[0].id, start_time: start, end_time: end });
  } catch (err) { next(err); }
});

// ── POST /api/admin/schedule/:id/combine ─────────────────────────────────────
// Merge every schedule row of the SAME event on the SAME date into this one row
// (all age groups together, at this row's venue/time) and delete the extras.
// Used when the age-group batching placed one event across two rows/venues and
// the office wants it as a single event.
router.post('/:id/combine', requireRole(...editRoles), async (req, res, next) => {
  try {
    if (req.user.role !== 'SuperAdmin' && await rowPublished(req.params.id))
      return res.status(403).json({ error: PUBLISHED_GUARD });
    const { rows: me } = await pool.query(
      `SELECT year_id, event_id, to_char(event_date,'YYYY-MM-DD') AS event_date, age_groups FROM schedule WHERE id = $1`, [req.params.id]);
    if (!me[0]) return res.status(404).json({ error: 'Schedule row not found' });
    const { rows: others } = await pool.query(
      `SELECT id, age_groups, status FROM schedule
        WHERE year_id = $1 AND event_id = $2 AND event_date = $3 AND id <> $4`,
      [me[0].year_id, me[0].event_id, me[0].event_date, req.params.id]);
    if (!others.length) return res.status(400).json({ error: 'No other rows of this event on this date to combine.' });
    if (req.user.role !== 'SuperAdmin' && others.some((o) => o.status === 'confirmed' || o.status === 'completed'))
      return res.status(403).json({ error: 'One of the rows is published — only the SuperAdmin can combine it.' });

    const codes = new Set();
    codesOf(me[0].age_groups).forEach((c) => codes.add(c));
    others.forEach((o) => codesOf(o.age_groups).forEach((c) => codes.add(c)));
    const { rows: ord } = await pool.query(
      `SELECT code FROM age_groups WHERE year_id = $1 AND code = ANY($2::text[]) ORDER BY sort_order NULLS LAST, code`,
      [me[0].year_id, [...codes]]);
    const ag = (ord.length ? ord.map((r) => r.code) : [...codes]).join(', ');

    await pool.query(`UPDATE schedule SET age_groups = $1, generated_by_scheduler = FALSE, updated_at = NOW() WHERE id = $2`, [ag, req.params.id]);
    await pool.query(`DELETE FROM schedule WHERE id = ANY($1)`, [others.map((o) => o.id)]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'SCHEDULE_COMBINE_ROWS', entity: 'schedule', entityId: req.params.id,
      details: { event_id: me[0].event_id, age_groups: ag, merged: others.length } });
    res.json({ ok: true, age_groups: ag, removed: others.length });
  } catch (err) { next(err); }
});

// ── POST /api/admin/schedule/:id/remove-group ────────────────────────────────
// Drop one age group from an event's scheduled row. If it was the last group,
// the whole row is removed.
router.post('/:id/remove-group', requireRole(...editRoles), async (req, res, next) => {
  try {
    if (req.user.role !== 'SuperAdmin' && await rowPublished(req.params.id))
      return res.status(403).json({ error: PUBLISHED_GUARD });
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
    if (req.user.role !== 'SuperAdmin' && await rowPublished(req.params.id))
      return res.status(403).json({ error: PUBLISHED_GUARD });
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
    // Phased publish: only LOCKED draft rows are published, up to and including
    // an optional cut-off date. Plain drafts and 'Looks good' (unlocked) rows
    // are never published — lock a day first to publish it.
    const cutoff = req.body?.cutoff_date;
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    if (cutoff && !ymd.test(cutoff))
      return res.status(400).json({ error: 'cutoff_date must be YYYY-MM-DD' });
    const { rows } = await pool.query(
      `UPDATE schedule SET status = 'confirmed', updated_at = NOW()
        WHERE year_id = $1 AND status = 'draft' AND is_locked = TRUE
          AND ($2::date IS NULL OR event_date <= $2::date)
        RETURNING id`, [yc.id, cutoff || null]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'PUBLISH_SCHEDULE', entity: 'schedule', entityId: yc.id,
      details: { confirmed_rows: rows.length, cutoff_date: cutoff || null } });
    res.json({ confirmed: rows.length, cutoff_date: cutoff || null });
  } catch (err) { next(err); }
});

// ── POST /api/admin/schedule/lock ────────────────────────────────────────────
// Lock the current (unlocked) placements as a committed phase. Locked rows are
// ── POST /api/admin/schedule/:id/unpublish  (SuperAdmin only) ────────────────
// Safety valve: pull a published (confirmed) row back to draft so it can be
// edited again. It keeps its Locked flag, so it shows as Locked (ready to
// re-publish). Only the SuperAdmin may do this.
router.post('/:id/unpublish', requireRole('SuperAdmin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE schedule SET status = 'draft', updated_at = NOW()
        WHERE id = $1 AND status IN ('confirmed','completed') RETURNING id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No published row with that id' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'UNPUBLISH_SCHEDULE_ROW', entity: 'schedule', entityId: req.params.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

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
        WHERE year_id = $1 AND is_locked = TRUE AND status = 'draft' RETURNING id`, [yc.id]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'UNLOCK_SCHEDULE_PHASE', entity: 'schedule', entityId: yc.id,
      details: { unlocked: rows.length } });
    res.json({ unlocked: rows.length });
  } catch (err) { next(err); }
});

module.exports = router;

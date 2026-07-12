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

const staffRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'];
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
    }
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });

    await client.query('BEGIN');
    const keep = [];
    for (const [i, v] of venues.entries()) {
      const { rows } = await client.query(
        `INSERT INTO venues (year_id, name, has_stage, capacity, suitable_for, weekday_hours, notes, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (year_id, name) DO UPDATE SET
           has_stage = EXCLUDED.has_stage, capacity = EXCLUDED.capacity,
           suitable_for = EXCLUDED.suitable_for, weekday_hours = EXCLUDED.weekday_hours,
           notes = EXCLUDED.notes, sort_order = EXCLUDED.sort_order
         RETURNING id`,
        [yc.id, v.name.trim(), v.has_stage !== false, v.capacity || null,
         v.suitable_for || [], JSON.stringify(v.weekday_hours || {}), v.notes || null, i]);
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
            setup_minutes = 10 } = req.body;

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
        if (h?.start && h?.end) blocks.push({ start: h.start, end: h.end, venues: [v.name] });
      }
      if (blocks.length) dailySlots.push({ date, blocks });
    }
    if (!dailySlots.length)
      return res.status(400).json({ error: 'No venue is available on any day in the window — check the venues\' weekday availability' });

    const config = {
      reportingBufferMinutes: Number(reporting_buffer_minutes) || 30,
      dailySlots,
    };

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
     * Event duration:
     *  - STAGE events perform sequentially: entries × per-participant time.
     *  - NON-STAGE events (drawing, writing…) work SIMULTANEOUSLY: one
     *    sitting of the allotted time (default 60 min), split into several
     *    consecutive sessions when entries exceed the best allowed venue's
     *    capacity.
     */
    const durationFor = (r, allowed) => {
      if (r.is_stage_event) {
        const perMin = r.allotted_time_seconds
          ? r.allotted_time_seconds / 60 : Number(minutes_per_participant_default);
        return Math.max(20, Math.ceil(r.participant_count * perMin) + Number(setup_minutes));
      }
      const caps = venueRows
        .filter((v) => allowed.includes(v.name))
        .map((v) => (v.capacity == null ? Infinity : v.capacity));
      const bestCap = caps.length ? Math.max(...caps) : Infinity;
      const sessions = bestCap === Infinity ? 1 : Math.max(1, Math.ceil(r.participant_count / bestCap));
      const perSession = r.allotted_time_seconds ? Math.ceil(r.allotted_time_seconds / 60) : 60;
      return Math.max(20, sessions * perSession + Number(setup_minutes));
    };

    // Adapter between the scheduler service and the real schema
    const db = {
      async getActiveEventsForYear(yearId) {
        const { rows } = await pool.query(
          `SELECT e.id AS event_id, COALESCE(c.name, 'Other') AS category,
                  e.allotted_time_seconds, e.is_stage_event,
                  COUNT(r.id)::int AS participant_count
           FROM events e
           LEFT JOIN categories c ON c.id = e.category_id
           JOIN registrations r ON r.event_id = e.id
             AND r.status NOT IN ('withdrawn','swapped')
           WHERE e.year_id = $1 AND e.is_cancelled = FALSE
           GROUP BY e.id, c.name`, [yearId]);
        return rows.map((r) => {
          const allowed = venueFor(r.category, r.is_stage_event);
          return {
            event_id: r.event_id,
            category: r.category,
            allowed_venues: allowed,
            participant_count: r.participant_count,
            is_stage_event: r.is_stage_event,
            duration_minutes: durationFor(r, allowed),
          };
        });
      },
      async getEventParticipants(yearId) {
        const { rows } = await pool.query(
          `SELECT r.event_id, COALESCE(r.participant_id, tm.participant_id) AS participant_id
           FROM registrations r
           LEFT JOIN team_members tm ON tm.team_id = r.team_id
           WHERE r.year_id = $1 AND r.status NOT IN ('withdrawn','swapped')
             AND COALESCE(r.participant_id, tm.participant_id) IS NOT NULL`, [yearId]);
        return rows;
      },
      async saveScheduleDraft(yearId, draft) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`DELETE FROM schedule WHERE year_id = $1 AND status = 'draft'`, [yearId]);
          for (const s of draft.scheduled) {
            await client.query(
              `INSERT INTO schedule (year_id, event_id, event_date, start_time, end_time, venue,
                                     status, generated_by_scheduler)
               VALUES ($1,$2,$3,$4,$5,$6,'draft',TRUE)`,
              [yearId, s.event_id, s.date, s.start_time, s.end_time, s.venue]);
          }
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK').catch(() => null);
          throw e;
        } finally { client.release(); }
      },
    };

    const events = await db.getActiveEventsForYear(yc.id);
    const eventById = new Map(events.map((e) => [e.event_id, e]));
    const { rows: nameRows } = await pool.query(
      `SELECT id, event_code, event_name FROM events WHERE year_id = $1`, [yc.id]);
    const names = new Map(nameRows.map((n) => [n.id, n]));

    const draft = await generateScheduleDraft(yc.id, config, db);

    // Human diagnostics: WHY couldn't each event be placed?
    const venueHasDays = (name) => {
      const v = venueRows.find((x) => x.name === name);
      return v && Object.keys(v.weekday_hours || {}).length > 0;
    };
    const blockMinutes = (h) => {
      const [sh, sm] = h.start.split(':').map(Number);
      const [eh, em] = h.end.split(':').map(Number);
      return (eh * 60 + em) - (sh * 60 + sm);
    };
    const longestBlockFor = (allowed) => {
      let best = 0, bestVenue = null;
      for (const v of venueRows) {
        if (!allowed.includes(v.name)) continue;
        for (const h of Object.values(v.weekday_hours || {})) {
          const m = blockMinutes(h);
          if (m > best) { best = m; bestVenue = v.name; }
        }
      }
      return { best, bestVenue };
    };

    const unplaced = draft.unplaced.map((u) => {
      const ev = eventById.get(u.event_id);
      const nm = names.get(u.event_id) || {};
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
      return { event_id: u.event_id, event_code: nm.event_code, event_name: nm.event_name,
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
router.get('/', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.json([]);
    const { rows } = await pool.query(
      `SELECT s.id, to_char(s.event_date, 'YYYY-MM-DD') AS event_date,
              s.start_time, s.end_time, s.venue, s.status, s.generated_by_scheduler,
              s.event_id, s.time_slot_id,
              e.event_code, e.event_name, e.event_kind, c.name AS category_name,
              (SELECT COUNT(*)::int FROM registrations r
               WHERE r.event_id = e.id AND r.status NOT IN ('withdrawn','swapped')) AS entries
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

module.exports = router;

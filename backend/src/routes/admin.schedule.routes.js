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

// ── POST /api/admin/schedule/generate-draft ──────────────────────────────────
// body: { venues: ["Main Stage","Hall B"],
//         blocks: [{start:"09:00", end:"13:00"}, {start:"15:00", end:"20:00"}],
//         dates?: ["2026-12-18", ...]   (defaults to the competition window)
//         reporting_buffer_minutes?, minutes_per_participant_default?,
//         setup_minutes? }
router.post('/generate-draft', requireRole(...editRoles), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });

    const { venues = [], blocks = [], dates,
            reporting_buffer_minutes = 30,
            minutes_per_participant_default = 5,
            setup_minutes = 10 } = req.body;
    if (!venues.length) return res.status(400).json({ error: 'At least one venue is required' });
    if (!blocks.length) return res.status(400).json({ error: 'At least one daily time block is required (e.g. 09:00–13:00)' });
    for (const b of blocks) {
      if (!/^\d{2}:\d{2}$/.test(b.start || '') || !/^\d{2}:\d{2}$/.test(b.end || ''))
        return res.status(400).json({ error: 'Blocks need start/end as HH:MM' });
    }

    let days = dates;
    if (!days?.length) {
      if (!yc.event_start_date || !yc.event_end_date)
        return res.status(400).json({ error: 'Set the competition start/end dates in Year Setup first (or pass dates)' });
      days = dateRange(yc.event_start_date, yc.event_end_date);
    }

    const config = {
      reportingBufferMinutes: Number(reporting_buffer_minutes) || 30,
      dailySlots: days.map((date) => ({
        date,
        blocks: blocks.map((b) => ({ start: b.start, end: b.end, venues })),
      })),
    };

    // Adapter between the scheduler service and the real schema
    const db = {
      async getActiveEventsForYear(yearId) {
        const { rows } = await pool.query(
          `SELECT e.id AS event_id, COALESCE(c.name, 'Other') AS category,
                  e.allotted_time_seconds,
                  COUNT(r.id)::int AS participant_count
           FROM events e
           LEFT JOIN categories c ON c.id = e.category_id
           JOIN registrations r ON r.event_id = e.id
             AND r.status NOT IN ('withdrawn','swapped')
           WHERE e.year_id = $1 AND e.is_cancelled = FALSE
           GROUP BY e.id, c.name`, [yearId]);
        return rows.map((r) => ({
          event_id: r.event_id,
          category: r.category,
          duration_minutes: Math.max(
            20,
            Math.ceil((r.participant_count *
              (r.allotted_time_seconds ? r.allotted_time_seconds / 60
                                       : Number(minutes_per_participant_default)))) +
              Number(setup_minutes)),
        }));
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

    const draft = await generateScheduleDraft(yc.id, config, db);

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'GENERATE_DRAFT_SCHEDULE', entity: 'schedule', entityId: yc.id,
      details: { scheduled: draft.scheduled.length, unplaced: draft.unplaced.length,
                 venues, days: days.length } });

    res.json({ scheduled: draft.scheduled.length, unplaced: draft.unplaced });
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

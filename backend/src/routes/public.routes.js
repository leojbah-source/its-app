// src/routes/public.routes.js  (mounted at /api/public -- no auth)
// Read-only, publicly visible data. Only ever exposes information that has
// already been published: schedule.status IN ('confirmed','completed'),
// event_results.is_published = true, notices.is_active = true,
// year_config.is_active = TRUE.
//
// NOTE ON CHEST NUMBERS (rule #22 in schema.sql): the schema's design rules
// say chest numbers should never be shown in the participant PWA. This file
// still exposes chest_number on /results, matching the original behaviour.
// Confirm whether that's intended for this public board.
//
// NOTE ON TEAM EVENTS: registrations.participant_id and registrations.team_id
// are mutually exclusive (a row is either an individual entry or a team
// entry). /results and /result-cards INNER JOIN participants, so team-event
// results are silently excluded from both endpoints. If team results need to
// show up publicly, that's separate work (resolving team_id -> teams.team_name
// instead of a participant name).
const express = require('express');
const pool = require('../db');

const router = express.Router();

// Resolves which year to show when the caller doesn't pass ?year_id= explicitly.
// There is no `years` table and no `status` column on year_config -- the
// "current" year is the single row with is_active = TRUE (a partial unique
// index guarantees at most one). Every other table's year_id is a foreign
// key to year_config.id, NOT the calendar `year` integer, so that's what
// this returns.
async function resolveYearId(queryYearId) {
  if (queryYearId) return queryYearId;
  const { rows } = await pool.query(
    `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`
  );
  return rows[0]?.id || null;
}

// GET /api/public/schedule?year_id=
router.get('/schedule', async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.query.year_id);
    if (!yearId) return res.json([]);

    // schedule_draft -> schedule; time_slots -> event_time_slots.
    // status IN ('confirmed','completed') is the public-visible equivalent
    // of "published" (confirmed Admin-publish, completed once the event has
    // run). placement_order doesn't exist; ordering by event_date/start_time
    // instead. events has no name/category/age_group/is_team_event columns
    // directly -- joined out below. Cancelled events are excluded.
    const { rows } = await pool.query(
      `SELECT e.event_name,
              cat.name AS category,
              string_agg(DISTINCT ag.label, ', ' ORDER BY ag.label) AS age_groups,
              (e.event_kind = 'team') AS is_team_event,
              sd.venue, sd.event_date, sd.start_time, sd.end_time,
              ts.slot_label
       FROM schedule sd
       JOIN events e ON e.id = sd.event_id
       LEFT JOIN categories cat ON cat.id = e.category_id
       LEFT JOIN event_age_groups eag ON eag.event_id = e.id
       LEFT JOIN age_groups ag ON ag.id = eag.age_group_id
       LEFT JOIN event_time_slots ts ON ts.id = sd.time_slot_id
       WHERE sd.year_id = $1
         AND sd.status IN ('confirmed', 'completed')
         AND e.is_cancelled = FALSE
       GROUP BY sd.id, e.id, cat.name, ts.slot_label
       ORDER BY sd.event_date, sd.start_time`,
      [yearId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/public/results?year_id=&event_id=
router.get('/results', async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.query.year_id);
    if (!yearId) return res.json([]);

    // results -> event_results; rank -> prize_place; children -> participants
    // (name -> full_name); school is a FK on participants, not a text column;
    // chest_numbers -> chest_assignments; age_group comes from the
    // registration (registrations.age_group_id), not from events.
    const { rows } = await pool.query(
      `SELECT e.event_name, cat.name AS category, ag.label AS age_group,
              res.prize_place AS rank, res.grade,
              res.rank_points, res.grade_points,
              p.full_name AS child_name, sch.name AS school,
              ca.chest_number
       FROM event_results res
       JOIN events e ON e.id = res.event_id
       JOIN registrations r ON r.id = res.registration_id
       JOIN participants p ON p.id = r.participant_id
       LEFT JOIN categories cat ON cat.id = e.category_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       LEFT JOIN schools sch ON sch.id = p.school_id
       LEFT JOIN chest_assignments ca ON ca.registration_id = res.registration_id
       WHERE r.year_id = $1 AND res.is_published = true
         AND ($2::int IS NULL OR res.event_id = $2)
       ORDER BY e.event_name, res.prize_place`,
      [yearId, req.query.event_id || null]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/public/result-cards?year_id=&event_id=  -- card-style grouping, one entry per participant
router.get('/result-cards', async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.query.year_id);
    if (!yearId) return res.json([]);

    // Same table/column fixes as /results. age_group here comes from
    // participants.age_group_id (one stable value per participant per year)
    // rather than per-registration, since a card groups across all of a
    // participant's events.
    const { rows } = await pool.query(
      `SELECT p.full_name AS child_name, sch.name AS school, ag.label AS age_group,
              json_agg(json_build_object(
                'event_name', e.event_name, 'rank', res.prize_place, 'grade', res.grade,
                'rank_points', res.rank_points, 'grade_points', res.grade_points
              ) ORDER BY e.event_name) AS results
       FROM event_results res
       JOIN events e ON e.id = res.event_id
       JOIN registrations r ON r.id = res.registration_id
       JOIN participants p ON p.id = r.participant_id
       LEFT JOIN schools sch ON sch.id = p.school_id
       LEFT JOIN age_groups ag ON ag.id = p.age_group_id
       WHERE r.year_id = $1 AND res.is_published = true
         AND ($2::int IS NULL OR res.event_id = $2)
       GROUP BY p.id, p.full_name, sch.name, ag.label
       ORDER BY p.full_name`,
      [yearId, req.query.event_id || null]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/public/notices?year_id=
// Backed by the new `notices` table (see accompanying CREATE TABLE script --
// run it in pgAdmin before deploying this). is_active gates public
// visibility, same role published_at IS NOT NULL played in the original
// (nonexistent) table; posted_at is aliased back to published_at in the
// response so existing frontend code doesn't need to change field names.
router.get('/notices', async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.query.year_id);
    const { rows } = await pool.query(
      `SELECT id, title, body, posted_at AS published_at
       FROM notices
       WHERE ($1::int IS NULL OR year_id = $1) AND is_active = TRUE
       ORDER BY posted_at DESC LIMIT 100`,
      [yearId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/public/awards/:year_id
// There's no `awards` table, and v_school_award_totals / v_group_championship
// can't be reused directly here: both views aggregate with SUM() over rows
// filtered on is_finalised = TRUE (Stage 1), so by the time you query the
// view's output, the per-row is_published flag is gone -- there's no column
// left to add a Stage-2 filter onto. So instead of querying the views, this
// recomputes the same aggregation directly against event_results filtered on
// is_published = TRUE, which is the only way to actually gate this on Stage 2
// (Chairman publish) rather than Stage 1 (Finalise+Print).
router.get('/awards/:year_id', async (req, res, next) => {
  try {
    const yearId = req.params.year_id;

    const { rows: schoolAwards } = await pool.query(
      `SELECT p.school_id, sch.name AS school_name,
              SUM(res.rank_points)             AS total_rank_points,
              SUM(res.grade_points)            AS total_grade_points,
              SUM(res.participation_bonus_pts) AS total_participation_pts,
              SUM(res.total_points)            AS grand_total
       FROM event_results res
       JOIN registrations r  ON r.id = res.registration_id
       JOIN participants p   ON p.id = r.participant_id
       JOIN schools sch      ON sch.id = p.school_id
       WHERE p.year_id = $1 AND res.is_published = TRUE
       GROUP BY p.school_id, sch.name
       ORDER BY grand_total DESC`,
      [yearId]
    );

    const { rows: groupChampionship } = await pool.query(
      `SELECT t.age_group_id, ag.label AS age_group_label,
              t.school_id, sch.name AS school_name,
              SUM(res.total_points) AS total_points
       FROM event_results res
       JOIN registrations r ON r.id = res.registration_id
       JOIN teams t         ON t.id = r.team_id
       JOIN age_groups ag   ON ag.id = t.age_group_id
       JOIN schools sch     ON sch.id = t.school_id
       WHERE t.year_id = $1 AND res.is_published = TRUE
       GROUP BY t.age_group_id, ag.label, t.school_id, sch.name
       ORDER BY ag.label, total_points DESC`,
      [yearId]
    );

    res.json({ school_award_totals: schoolAwards, group_championship: groupChampionship });
  } catch (err) {
    next(err);
  }
});

// GET /api/public/events/:id/criteria
router.get('/events/:id/criteria', async (req, res, next) => {
  try {
    // events has no name/category/age_group/is_team_event columns directly;
    // criteria -> event_criteria; name -> criterion_name; sort_order ->
    // sequence_order. Response shape kept the same (criteria items still
    // have name/max_score) so existing frontend code doesn't need changes.
    const { rows: eventRows } = await pool.query(
      `SELECT e.event_name, cat.name AS category,
              string_agg(DISTINCT ag.label, ', ' ORDER BY ag.label) AS age_groups,
              (e.event_kind = 'team') AS is_team_event
       FROM events e
       LEFT JOIN categories cat ON cat.id = e.category_id
       LEFT JOIN event_age_groups eag ON eag.event_id = e.id
       LEFT JOIN age_groups ag ON ag.id = eag.age_group_id
       WHERE e.id = $1
       GROUP BY e.id, e.event_name, cat.name, e.event_kind`,
      [req.params.id]
    );
    if (!eventRows[0]) return res.status(404).json({ error: 'Event not found' });

    const { rows: criteria } = await pool.query(
      `SELECT criterion_name AS name, max_score FROM event_criteria WHERE event_id = $1 ORDER BY sequence_order`,
      [req.params.id]
    );
    res.json({ event: eventRows[0], criteria });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

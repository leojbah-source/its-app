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

// GET /api/public/year — the active year's public branding + id (for /awards, headers)
router.get('/year', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, year, event_year_label, its_logo_url, kca_logo_url, sponsor_logo_url, sponsor_name, rules_pdf_url, list_files, list_board_title
       FROM year_config WHERE is_active = TRUE LIMIT 1`);
    res.json(rows[0] || null);
  } catch (err) { next(err); }
});

// GET /api/public/stage/:event_id — the currently running timing for a big stage
// screen (chest number + times only; no personal data). Public and read-only.
router.get('/stage/:event_id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT pt.chest_no AS chest_number,
              EXTRACT(EPOCH FROM pt.start_time) * 1000 AS start_ms,
              EXTRACT(EPOCH FROM NOW()) * 1000 AS server_ms,
              e.event_name, e.allotted_time_seconds, e.yellow_alert_seconds, e.grace_period_seconds
       FROM participant_timings pt JOIN events e ON e.id = pt.event_id
       WHERE pt.event_id = $1 AND pt.start_time IS NOT NULL AND pt.end_time IS NULL
       ORDER BY pt.start_time DESC LIMIT 1`, [req.params.event_id]);
    if (rows[0]) return res.json({ running: rows[0], server_ms: rows[0].server_ms });
    const { rows: e2 } = await pool.query(
      `SELECT event_name, allotted_time_seconds, yellow_alert_seconds, grace_period_seconds FROM events WHERE id = $1`,
      [req.params.event_id]);
    res.json({ running: null, event: e2[0] || null, server_ms: Date.now() });
  } catch (err) { next(err); }
});

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
    // One row per (scheduled row x age group ACTUALLY on that row). We show the
    // reporting time per age group (not the run window), staggered for stage
    // events: first group reports 15 min before start; each next group reports
    // 30 min before its turn (i.e. the running total of earlier groups' time
    // less 30). Age groups come from the scheduled row (sd.age_groups), NOT the
    // event's full configuration — so only the groups actually scheduled show.
    const { rows } = await pool.query(
      `SELECT sd.id AS sched_id, e.event_name, (e.event_kind = 'team') AS is_team_event,
              sd.venue, to_char(sd.event_date, 'YYYY-MM-DD') AS event_date,
              to_char(sd.start_time, 'HH24:MI') AS start_time,
              e.is_stage_event, e.allotted_time_seconds, sd.group_meta,
              ag.code, ag.label, ag.sort_order,
              (SELECT COUNT(*) FROM registrations r
                 LEFT JOIN participants pr ON pr.id = r.participant_id
                WHERE r.event_id = sd.event_id AND r.status NOT IN ('withdrawn','swapped')
                  AND (pr.confirmed_at IS NOT NULL OR r.team_id IS NOT NULL)
                  AND r.age_group_id = ag.id) AS cnt
         FROM schedule sd
         JOIN events e ON e.id = sd.event_id
         JOIN age_groups ag ON ag.year_id = sd.year_id
              AND ag.code = ANY(string_to_array(sd.age_groups, ', '))
        WHERE sd.year_id = $1 AND sd.status IN ('confirmed','completed') AND e.is_cancelled = FALSE
        ORDER BY sd.event_date, sd.start_time NULLS LAST, sd.id, ag.sort_order NULLS LAST, ag.code`,
      [yearId]
    );

    const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
    const fmt = (min) => { if (min == null) return null; const x = ((min % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

    const bySched = new Map();
    for (const r of rows) {
      if (!bySched.has(r.sched_id)) bySched.set(r.sched_id, {
        event_name: r.event_name, is_team_event: r.is_team_event, venue: r.venue,
        event_date: r.event_date, start_time: r.start_time,
        is_stage_event: r.is_stage_event, allotted: r.allotted_time_seconds, group_meta: r.group_meta || {}, groups: [] });
      bySched.get(r.sched_id).groups.push({ code: r.code, label: r.label, cnt: Number(r.cnt) || 0 });
    }

    const out = [];
    for (const s of bySched.values()) {
      const start = s.start_time ? toMin(s.start_time) : null;
      const perMin = s.allotted ? s.allotted / 60 : 5;
      const timeAllowed = s.allotted ? `${Math.round((s.allotted / 60) * 10) / 10} min` : null;
      const gm = s.group_meta || {};
      let groups;
      if (start == null) {
        groups = s.groups.map((g) => ({ code: g.code, label: g.label, time_allowed: timeAllowed, report: null }));
      } else if (!s.is_stage_event || s.groups.length <= 1) {
        groups = s.groups.map((g) => ({ code: g.code, label: g.label, time_allowed: timeAllowed, report: fmt(start - 15) }));
      } else {
        let performStart = start;
        groups = s.groups.map((g, i) => {
          const rep = i === 0 ? start - 15 : performStart - 30;
          performStart += Math.ceil(g.cnt * perMin);
          return { code: g.code, label: g.label, time_allowed: timeAllowed, report: fmt(rep) };
        });
      }
      // Per-group reporting overrides win over the auto-staggered value.
      groups = groups.map((g) => (gm[g.code] && gm[g.code].reporting)
        ? { ...g, report: fmt(toMin(gm[g.code].reporting)) } : g);
      out.push({ event_name: s.event_name, is_team_event: s.is_team_event,
        venue: s.venue, event_date: s.event_date, groups });
    }
    res.json(out);
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
      `SELECT res.event_id, e.event_code, e.event_name, cat.name AS category,
              r.age_group_id, ag.label AS age_group, ag.sort_order AS ag_sort,
              res.prize_place AS place, res.final_rank AS rank, res.grade,
              res.rank_points, res.grade_points,
              p.full_name AS child_name, sch.name AS school,
              ca.chest_number,
              (SELECT to_char(MIN(s.event_date), 'YYYY-MM-DD') FROM schedule s WHERE s.event_id = res.event_id) AS event_date
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
       ORDER BY event_date NULLS LAST, e.event_code, ag.sort_order NULLS LAST, res.final_rank NULLS LAST, res.prize_place`,
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
      `SELECT id, title, body, attachment_url, attachment_type, posted_at AS published_at
       FROM notices
       WHERE ($1::int IS NULL OR year_id = $1) AND is_active = TRUE
       ORDER BY posted_at DESC LIMIT 100`,
      [yearId]
    );
    res.json(rows);
  } catch (err) {
    // The notices table is optional — if it hasn't been created yet, the board
    // should still work. Treat a missing relation as simply "no notices".
    if (err && err.code === '42P01') return res.json([]);
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
              -- school award (rule #16) includes participation; total_points no longer does
              SUM(res.rank_points + res.grade_points + res.participation_bonus_pts) AS grand_total
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

// GET /api/public/judge-invite?k=KEY — no login, link-key gated.
// Powers the shareable judge-invitation generator. Returns only non-sensitive
// branding (logos + year label) and the still-to-be-judged scheduled sessions
// (completed ones — past date, schedule.status='completed', or results already
// published for that age group — are hidden). The key is year_config.invite_tool_key.
router.get('/judge-invite', async (req, res, next) => {
  try {
    const key = String(req.query.k || '').trim();
    if (!key) return res.status(401).json({ error: 'Missing link key.' });

    const { rows: yc } = await pool.query(
      `SELECT id, event_year_label, kca_logo_url, its_logo_url, sponsor_logo_url,
              sponsor_name, website_domain, invite_tool_key
         FROM year_config WHERE is_active = TRUE LIMIT 1`);
    const cfg = yc[0];
    if (!cfg || !cfg.invite_tool_key || cfg.invite_tool_key !== key) {
      return res.status(403).json({ error: 'This link is not valid.' });
    }

    const { rows: sessions } = await pool.query(
      `SELECT e.event_code, e.event_name, c.name AS category_name,
              to_char(s.event_date, 'YYYY-MM-DD') AS event_date,
              to_char(s.start_time, 'HH24:MI') AS start_time, s.venue,
              e.id AS event_id, ag.id AS age_group_id,
              ag.code AS age_group_code, ag.label AS age_group_label
         FROM schedule s
         JOIN events e ON e.id = s.event_id
         LEFT JOIN categories c ON c.id = e.category_id
         CROSS JOIN LATERAL unnest(string_to_array(COALESCE(NULLIF(s.age_groups, ''), s.age_groups), ', ')) AS grp(code)
         JOIN age_groups ag ON ag.year_id = s.year_id AND ag.code = trim(grp.code)
        WHERE s.year_id = $1
          AND COALESCE(s.age_groups, '') <> ''
          AND e.is_cancelled = FALSE
          AND s.status <> 'completed'
          AND s.event_date >= (now() AT TIME ZONE 'Asia/Bahrain')::date
          AND NOT (SELECT (COUNT(*) > 0 AND COUNT(*) FILTER (WHERE er.is_published) = COUNT(*))
                     FROM registrations rr LEFT JOIN event_results er ON er.registration_id = rr.id
                    WHERE rr.event_id = e.id AND rr.age_group_id = ag.id AND rr.status = 'attended')
        ORDER BY s.event_date, s.start_time NULLS LAST, e.event_code, ag.sort_order`,
      [cfg.id]);

    const { invite_tool_key, id, ...branding } = cfg;
    res.json({ config: branding, sessions });
  } catch (err) { next(err); }
});

// ── GET /api/public/live/dates ───────────────────────────────────────────────
// Published event dates for the live-progress date picker (parent/participant).
router.get('/live/dates', async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.query.year_id);
    if (!yearId) return res.json([]);
    const { rows } = await pool.query(
      `SELECT DISTINCT to_char(s.event_date,'YYYY-MM-DD') AS d
         FROM schedule s
        WHERE s.year_id = $1 AND s.event_date IS NOT NULL
          AND s.status IN ('confirmed','completed')
        ORDER BY d`, [yearId]);
    res.json(rows.map((r) => r.d));
  } catch (err) { next(err); }
});

// ── GET /api/public/live/day?date=YYYY-MM-DD ─────────────────────────────────
// Chest-only live progress for parents/participants: for each published group on
// the date, each chest's status (pending → on stage → done) from the Timer. No
// participant names are returned here (privacy) — only chest numbers.
router.get('/live/day', async (req, res, next) => {
  try {
    const date = req.query.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    const yearId = await resolveYearId(req.query.year_id);
    if (!yearId) return res.json([]);

    const { rows } = await pool.query(
      `SELECT s.id AS sched_id, s.venue, to_char(s.start_time,'HH24:MI') AS start_time,
              s.event_id, e.event_code, e.event_name, e.is_stage_event,
              ag.id AS ag_id, ag.code AS ag_code, ag.label AS ag_label, ag.sort_order AS ag_sort,
              r.id AS registration_id, ca.chest_number,
              pt.start_time AS t_start, pt.end_time AS t_end, pt.flag_for_dq,
              egt.started_at AS gt_started, egt.ends_at AS gt_ends, egt.ended_at AS gt_ended,
              egt.duration_seconds AS gt_duration,
              (SELECT (COUNT(*) > 0 AND COUNT(*) FILTER (WHERE er.is_published) = COUNT(*))
                 FROM registrations rr LEFT JOIN event_results er ON er.registration_id = rr.id
                WHERE rr.event_id = s.event_id AND rr.age_group_id = ag.id AND rr.status = 'attended') AS published
         FROM schedule s
         JOIN events e ON e.id = s.event_id
         JOIN age_groups ag ON ag.year_id = s.year_id AND ag.code = ANY(string_to_array(s.age_groups, ', '))
         LEFT JOIN registrations r ON r.event_id = s.event_id AND r.age_group_id = ag.id AND r.status = 'attended'
         LEFT JOIN chest_assignments ca ON ca.registration_id = r.id
         LEFT JOIN event_group_timers egt ON egt.event_id = s.event_id AND egt.age_group_id = ag.id
         LEFT JOIN LATERAL (SELECT start_time, end_time, flag_for_dq FROM participant_timings pt2
                             WHERE pt2.registration_id = r.id AND pt2.event_id = s.event_id
                             ORDER BY pt2.id DESC LIMIT 1) pt ON TRUE
        WHERE s.year_id = $1 AND s.event_date = $2
          AND s.status IN ('confirmed','completed')
        ORDER BY s.start_time NULLS LAST, s.venue, e.event_code, ag.sort_order NULLS LAST, ca.chest_number NULLS LAST`,
      [yearId, date]);

    const groups = new Map();
    for (const r of rows) {
      const key = `${r.sched_id}:${r.ag_code}`;
      if (!groups.has(key)) groups.set(key, {
        key, event_code: r.event_code, event_name: r.event_name,
        is_stage_event: r.is_stage_event, venue: r.venue, start_time: r.start_time,
        age_group_code: r.ag_code, age_group_label: r.ag_label, published: !!r.published, participants: [],
        _gt: (r.gt_started ? { started_at: r.gt_started, ends_at: r.gt_ends, ended_at: r.gt_ended, duration_seconds: r.gt_duration } : null) });
      if (r.registration_id) {
        const status = r.t_start && r.t_end ? 'done' : r.t_start ? 'running' : 'pending';
        groups.get(key).participants.push({ chest_number: r.chest_number, status, over: !!r.flag_for_dq });
      }
    }

    const nowMs = Date.now();
    const shapeGT = (gt) => {
      if (!gt || !gt.started_at) return null;
      const ends = new Date(gt.ends_at).getTime();
      const finished = !!gt.ended_at || nowMs >= ends;
      return {
        started_at: gt.started_at, ends_at: gt.ends_at, ended_at: gt.ended_at,
        duration_seconds: gt.duration_seconds,
        state: finished ? 'finished' : 'running',
        remaining_seconds: finished ? 0 : Math.max(0, Math.round((ends - nowMs) / 1000)),
      };
    };
    const out = [...groups.values()].map((g) => {
      const { _gt, ...rest } = g;
      const group_timer = shapeGT(_gt);
      const total = g.participants.length;
      const done = g.participants.filter((p) => p.status === 'done').length;
      const running = g.participants.filter((p) => p.status === 'running');
      const state = g.published
        ? 'finished'               // results published → the contest is over, even if a chest was never timed
        : group_timer
        ? group_timer.state
        : total === 0 ? 'empty'
          : done === total ? 'finished'
          : running.length ? 'running'
          : done > 0 ? 'in_progress' : 'not_started';
      return {
        ...rest, group_timer, total, done, running_count: running.length,
        now: g.published ? [] : running.map((p) => ({ chest_number: p.chest_number })),
        state,
      };
    });
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;

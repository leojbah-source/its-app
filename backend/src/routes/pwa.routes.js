// src/routes/pwa.routes.js  (mounted at /api/pwa, requires pwa-login JWT)
// Rule #21: PWA login via name_prefix+cpr_suffix (see auth.routes.js).
// Rule #22: Chest numbers must NEVER be shown in the PWA, anywhere.
// Rule #23: My Results = event name, grade, rank pts, grade pts per event + running totals.
const express = require('express');
const pool = require('../db');
const { authenticate, requireType } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireType('pwa'));

// GET /api/pwa/my-schedule — this participant's personal events, NO chest numbers (rule #22)
router.get('/my-schedule', async (req, res, next) => {
  try {
    // One row per event the child is in. If the event is published, s.* holds the
    // scheduled row (that also contains the child's age group) and sched_groups is
    // the ordered list of that row's groups + confirmed counts, used to compute the
    // child's own staggered reporting time.
    const { rows } = await pool.query(
      `SELECT e.event_name, (e.event_kind = 'team') AS is_team_event,
              ag.code AS my_code, ag.label AS age_group,
              e.is_stage_event, e.allotted_time_seconds,
              s.venue, to_char(s.event_date,'YYYY-MM-DD') AS event_date,
              to_char(s.start_time,'HH24:MI') AS start_time,
              s.age_groups,
              (SELECT json_agg(json_build_object('code', ag2.code, 'cnt',
                        (SELECT COUNT(*) FROM registrations r2
                           LEFT JOIN participants pr2 ON pr2.id = r2.participant_id
                          WHERE r2.event_id = e.id AND r2.status NOT IN ('withdrawn','swapped')
                            AND (pr2.confirmed_at IS NOT NULL OR r2.team_id IS NOT NULL)
                            AND r2.age_group_id = ag2.id)) ORDER BY ag2.sort_order)
                 FROM age_groups ag2
                WHERE ag2.year_id = r.year_id AND s.age_groups IS NOT NULL
                  AND ag2.code = ANY(string_to_array(s.age_groups, ', '))) AS sched_groups
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       LEFT JOIN LATERAL (
         SELECT venue, event_date, start_time, age_groups
         FROM schedule sd
         WHERE sd.event_id = r.event_id AND sd.year_id = r.year_id
           AND sd.status IN ('confirmed','completed')
           AND ag.code = ANY(string_to_array(sd.age_groups, ', '))
         ORDER BY sd.event_date, sd.start_time LIMIT 1
       ) s ON TRUE
       WHERE r.participant_id = $1 AND r.status NOT IN ('withdrawn','swapped')
       ORDER BY s.event_date NULLS LAST, s.start_time NULLS LAST, e.event_name`,
      [req.user.participantId]
    );

    const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
    const fmt = (min) => { if (min == null) return null; const x = ((min % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

    const out = rows.map((r) => {
      let report = null;
      if (r.start_time) {
        const start = toMin(r.start_time);
        const perMin = r.allotted_time_seconds ? r.allotted_time_seconds / 60 : 5;
        const groups = Array.isArray(r.sched_groups) ? r.sched_groups : [];
        const idx = groups.findIndex((g) => g.code === r.my_code);
        if (!r.is_stage_event || groups.length <= 1 || idx <= 0) {
          report = fmt(start - 15);
        } else {
          let earlier = 0;
          for (let i = 0; i < idx; i++) earlier += Math.ceil((Number(groups[i].cnt) || 0) * perMin);
          report = fmt(start + earlier - 30);
        }
      }
      return {
        event_name: r.event_name, is_team_event: r.is_team_event, age_group: r.age_group,
        venue: r.venue, event_date: r.event_date, scheduled: !!r.start_time, report,
      };
    });
    res.json(out);
  } catch (err) { next(err); }
});

// GET /api/pwa/my-results — per event: grade, rank pts, grade pts + running totals (rule #23)
router.get('/my-results', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.event_name, c.name AS category, ag.label AS age_group,
              er.prize_place, er.grade, er.rank_points, er.grade_points,
              er.participation_bonus_pts, er.total_points, er.extra_prize_type
       FROM event_results er
       JOIN registrations r ON r.id = er.registration_id
       JOIN events e ON e.id = er.event_id
       LEFT JOIN categories c ON c.id = e.category_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       WHERE r.participant_id = $1 AND er.is_published = TRUE
       ORDER BY e.event_name`,
      [req.user.participantId]
    );

    const totals = rows.reduce(
      (acc, r) => ({
        rank_points: acc.rank_points + Number(r.rank_points || 0),
        grade_points: acc.grade_points + Number(r.grade_points || 0),
        participation_bonus_pts: acc.participation_bonus_pts + Number(r.participation_bonus_pts || 0),
        total_points: acc.total_points + Number(r.total_points || 0),
      }),
      { rank_points: 0, grade_points: 0, participation_bonus_pts: 0, total_points: 0 }
    );

    res.json({ results: rows, totals });
  } catch (err) { next(err); }
});

module.exports = router;

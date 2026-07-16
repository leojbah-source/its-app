// src/routes/admin.judging.routes.js  (mounted at /api/admin)
// RESULTS — rank-aggregation model. Each judge ranks the group by their own
// totals; a participant's PLACEMENT is by the SUM of the three judges' ranks
// (lowest wins), ties broken by the briefing order (C1 totals, then C2 …) and
// flagged. GRADE (A/B/C) is by the average score % (separate from placement).
// Divergence flagged when a participant's ranks differ across judges beyond the
// threshold (rule #7). Two-stage: finalise (print) then Chairman publish (#13).
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);
const viewRoles = ['SuperAdmin', 'Chairman'];
const publishRoles = ['SuperAdmin', 'Chairman'];

async function activeCfg() {
  const { rows } = await pool.query(
    `SELECT id, grade_a_pct, grade_b_pct, grade_c_pct, grade_a_pts, grade_b_pts, grade_c_pts,
            rank_pts_first, rank_pts_second, rank_pts_third, participation_bonus_pts,
            divergence_threshold_pct
     FROM year_config WHERE is_active = TRUE LIMIT 1`);
  return rows[0] || null;
}

// Standard competition ranking (ties share a rank): value desc.
function rankByDesc(items, valueOf) {
  const sorted = [...items].sort((a, b) => valueOf(b) - valueOf(a));
  const rank = new Map();
  let r = 0, prev = null;
  sorted.forEach((it, i) => { const v = valueOf(it); if (v !== prev) { r = i + 1; prev = v; } rank.set(it, r); });
  return rank;
}

// Live computation for one (event, age group). Returns meta + per-participant rows.
async function computeGroup(eventId, ageGroupId, cfg) {
  const { rows: participants } = await pool.query(
    `SELECT r.id AS registration_id, ca.chest_number
     FROM registrations r JOIN chest_assignments ca ON ca.registration_id = r.id
     WHERE r.event_id = $1 AND r.age_group_id = $2 AND r.status = 'attended'
     ORDER BY ca.chest_number`, [eventId, ageGroupId]);
  const { rows: judges } = await pool.query(
    `SELECT ja.id AS assignment_id, j.full_name FROM judge_assignments ja
     JOIN judges j ON j.id = ja.judge_id WHERE ja.event_id = $1 ORDER BY j.full_name`, [eventId]);
  const { rows: criteria } = await pool.query(
    `SELECT id, criterion_name AS label, max_score, sequence_order
     FROM event_criteria WHERE event_id = $1 ORDER BY sequence_order, id`, [eventId]);
  const critIds = criteria.map((c) => c.id);
  const regIds = participants.map((p) => p.registration_id);
  const asgIds = judges.map((j) => j.assignment_id);

  let scores = [];
  if (asgIds.length && regIds.length) {
    const r = await pool.query(
      `SELECT judge_assignment_id, registration_id, criterion_id, score_value
       FROM scores WHERE judge_assignment_id = ANY($1) AND registration_id = ANY($2)`, [asgIds, regIds]);
    scores = r.rows;
  }
  // maps
  const total = {};       // `${asg}:${reg}` -> sum
  const cnt = {};         // `${asg}:${reg}` -> #criteria scored
  const critScore = {};   // `${asg}:${reg}:${crit}` -> value
  for (const s of scores) {
    const k = `${s.judge_assignment_id}:${s.registration_id}`;
    total[k] = (total[k] || 0) + Number(s.score_value);
    cnt[k] = (cnt[k] || 0) + 1;
    critScore[`${k}:${s.criterion_id}`] = Number(s.score_value);
  }
  const judgeTotal = (asg, reg) => total[`${asg}:${reg}`] || 0;
  const fullyScored = (asg, reg) => (cnt[`${asg}:${reg}`] || 0) === critIds.length && critIds.length > 0;

  // completeness: every judge scored every participant fully
  let complete = judges.length > 0 && participants.length > 0;
  for (const j of judges) for (const p of participants) if (!fullyScored(j.assignment_id, p.registration_id)) complete = false;

  // per-judge ranks of participants (by that judge's total)
  const judgeRank = {}; // `${asg}:${reg}` -> rank
  for (const j of judges) {
    const rk = rankByDesc(participants, (p) => judgeTotal(j.assignment_id, p.registration_id));
    for (const p of participants) judgeRank[`${j.assignment_id}:${p.registration_id}`] = rk.get(p);
  }

  const absThresh = Math.round((participants.length * Number(cfg.divergence_threshold_pct)) / 100);

  const rows = participants.map((p) => {
    const reg = p.registration_id;
    const perJudge = judges.map((j) => ({
      judge: j.full_name,
      total: judgeTotal(j.assignment_id, reg),
      rank: judgeRank[`${j.assignment_id}:${reg}`],
    }));
    const rankSum = perJudge.reduce((t, x) => t + (x.rank || 0), 0);
    const avgPct = judges.length ? perJudge.reduce((t, x) => t + x.total, 0) / judges.length : 0;
    const ranks = perJudge.map((x) => x.rank).filter((x) => x != null);
    const divergence = ranks.length >= 2 && (Math.max(...ranks) - Math.min(...ranks)) > absThresh;
    // per-criterion total across judges (for tiebreak, C1 first)
    const critTotals = criteria.map((c) => judges.reduce((t, j) => t + (critScore[`${j.assignment_id}:${reg}:${c.id}`] || 0), 0));
    let grade = null;
    if (avgPct >= Number(cfg.grade_a_pct)) grade = 'A';
    else if (avgPct >= Number(cfg.grade_b_pct)) grade = 'B';
    else if (avgPct >= Number(cfg.grade_c_pct)) grade = 'C';
    return { registration_id: reg, chest_number: p.chest_number, perJudge, rankSum, avgPct: Math.round(avgPct * 100) / 100, divergence, critTotals, grade };
  });

  // placement: rankSum asc, tiebreak by critTotals (C1..) desc
  const ordered = [...rows].sort((a, b) => {
    if (a.rankSum !== b.rankSum) return a.rankSum - b.rankSum;
    for (let i = 0; i < a.critTotals.length; i++) if (b.critTotals[i] !== a.critTotals[i]) return b.critTotals[i] - a.critTotals[i];
    return 0;
  });
  const rankSumCount = {};
  rows.forEach((r) => { rankSumCount[r.rankSum] = (rankSumCount[r.rankSum] || 0) + 1; });
  const maxPlaces = Math.min(3, participants.length);
  ordered.forEach((r, i) => {
    r.place = i < maxPlaces ? i + 1 : null;
    r.tie = rankSumCount[r.rankSum] > 1;
    // points
    const rp = r.place === 1 ? cfg.rank_pts_first : r.place === 2 ? cfg.rank_pts_second : r.place === 3 ? cfg.rank_pts_third : 0;
    const gp = r.grade === 'A' ? cfg.grade_a_pts : r.grade === 'B' ? cfg.grade_b_pts : r.grade === 'C' ? cfg.grade_c_pts : 0;
    r.rank_points = Number(rp) || 0;
    r.grade_points = Number(gp) || 0;
    r.participation_bonus_pts = Number(cfg.participation_bonus_pts) || 0;
    r.total_points = r.rank_points + r.grade_points + r.participation_bonus_pts;
  });

  return {
    event_id: eventId, age_group_id: ageGroupId,
    judges: judges.map((j) => j.full_name),
    criteria, participant_count: participants.length,
    complete, divergence_threshold_pct: Number(cfg.divergence_threshold_pct), absolute_threshold: absThresh,
    results: ordered.map((r) => ({
      registration_id: r.registration_id, chest_number: r.chest_number, per_judge: r.perJudge,
      rank_sum: r.rankSum, avg_pct: r.avgPct, place: r.place, grade: r.grade,
      tie_flag: r.tie, divergence_flag: r.divergence,
      rank_points: r.rank_points, grade_points: r.grade_points,
      participation_bonus_pts: r.participation_bonus_pts, total_points: r.total_points,
    })),
  };
}

async function groupState(eventId, ageGroupId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE er.is_finalised)::int AS finalised,
            COUNT(*) FILTER (WHERE er.is_published)::int AS published
     FROM registrations r
     LEFT JOIN event_results er ON er.registration_id = r.id
     WHERE r.event_id = $1 AND r.age_group_id = $2 AND r.status = 'attended'`, [eventId, ageGroupId]);
  const s = rows[0];
  return { finalised: s.n > 0 && s.finalised === s.n, published: s.n > 0 && s.published === s.n, computed: s.finalised > 0 || s.published > 0 };
}

// ── GET /api/admin/results/:event_id/groups — groups + result state ──────────
router.get('/results/:event_id/groups', requireRole(...viewRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ag.id AS age_group_id, ag.code, ag.label, ag.sort_order,
              COUNT(DISTINCT ca.registration_id)::int AS participant_count
       FROM registrations r JOIN age_groups ag ON ag.id = r.age_group_id
       JOIN chest_assignments ca ON ca.registration_id = r.id
       WHERE r.event_id = $1 AND r.status = 'attended'
       GROUP BY ag.id, ag.code, ag.label, ag.sort_order
       ORDER BY ag.sort_order, ag.code`, [req.params.event_id]);
    for (const g of rows) Object.assign(g, await groupState(req.params.event_id, g.age_group_id));
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/results/:event_id/:age_group_id — live results + state ────
router.get('/results/:event_id/:age_group_id', requireRole(...viewRoles), async (req, res, next) => {
  try {
    const cfg = await activeCfg();
    if (!cfg) return res.status(400).json({ error: 'No active year' });
    const data = await computeGroup(Number(req.params.event_id), Number(req.params.age_group_id), cfg);
    const { rows: ev } = await pool.query(
      `SELECT e.event_code, e.event_name, c.name AS category_name, ag.code AS age_group_code
       FROM events e LEFT JOIN categories c ON c.id = e.category_id
       LEFT JOIN age_groups ag ON ag.id = $2 WHERE e.id = $1`, [req.params.event_id, req.params.age_group_id]);
    res.json({ ...data, event: ev[0] || null, state: await groupState(req.params.event_id, req.params.age_group_id) });
  } catch (err) { next(err); }
});

// ── POST /api/admin/results/:event_id/:age_group_id/compute — persist ────────
router.post('/results/:event_id/:age_group_id/compute', requireRole(...viewRoles), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const cfg = await activeCfg();
    if (!cfg) return res.status(400).json({ error: 'No active year' });
    const eventId = Number(req.params.event_id), ag = Number(req.params.age_group_id);
    const data = await computeGroup(eventId, ag, cfg);
    await client.query('BEGIN');
    for (const r of data.results) {
      await client.query(
        `INSERT INTO event_results
           (registration_id, event_id, prize_place, grade, rank_points, grade_points,
            participation_bonus_pts, tie_flag, divergence_flag)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (registration_id) DO UPDATE SET
           prize_place = EXCLUDED.prize_place, grade = EXCLUDED.grade,
           rank_points = EXCLUDED.rank_points, grade_points = EXCLUDED.grade_points,
           participation_bonus_pts = EXCLUDED.participation_bonus_pts,
           tie_flag = EXCLUDED.tie_flag, divergence_flag = EXCLUDED.divergence_flag,
           updated_at = NOW()
         WHERE event_results.is_published = FALSE`,
        [r.registration_id, eventId, r.place, r.grade, r.rank_points, r.grade_points,
         r.participation_bonus_pts, r.tie_flag, r.divergence_flag]);
    }
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'COMPUTE_RESULTS', entity: 'events', entityId: eventId, details: { age_group_id: ag, n: data.results.length } });
    res.json({ saved: data.results.length, complete: data.complete });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── POST /api/admin/results/:event_id/:age_group_id/finalise (Stage 1) ───────
router.post('/results/:event_id/:age_group_id/finalise', requireRole(...viewRoles), async (req, res, next) => {
  try {
    const cfg = await activeCfg();
    const eventId = Number(req.params.event_id), ag = Number(req.params.age_group_id);
    const data = await computeGroup(eventId, ag, cfg);
    if (!data.complete) return res.status(409).json({ error: 'All judges must finish scoring every participant before finalising.' });
    // ensure rows exist, then finalise
    const { rows } = await pool.query(
      `UPDATE event_results er SET is_finalised = TRUE, finalised_by = $1, finalised_at = NOW(), updated_at = NOW()
       FROM registrations r
       WHERE er.registration_id = r.id AND r.event_id = $2 AND r.age_group_id = $3 AND er.is_published = FALSE
       RETURNING er.id`, [req.user.id, eventId, ag]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'FINALISE_RESULTS', entity: 'events', entityId: eventId, details: { age_group_id: ag, rows: rows.length } });
    res.json({ finalised: rows.length });
  } catch (err) { next(err); }
});

// ── POST /api/admin/results/:event_id/:age_group_id/publish (Stage 2) ────────
router.post('/results/:event_id/:age_group_id/publish', requireRole(...publishRoles), async (req, res, next) => {
  try {
    const eventId = Number(req.params.event_id), ag = Number(req.params.age_group_id);
    const { rows } = await pool.query(
      `UPDATE event_results er SET is_published = TRUE, published_by = $1, published_at = NOW(), updated_at = NOW()
       FROM registrations r
       WHERE er.registration_id = r.id AND r.event_id = $2 AND r.age_group_id = $3 AND er.is_finalised = TRUE
       RETURNING er.id`, [req.user.id, eventId, ag]);
    if (!rows.length) return res.status(409).json({ error: 'Finalise the results before publishing.' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'PUBLISH_RESULTS', entity: 'events', entityId: eventId, details: { age_group_id: ag, rows: rows.length } });
    res.json({ published: rows.length });
  } catch (err) { next(err); }
});

module.exports = router;

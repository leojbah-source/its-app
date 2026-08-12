// src/routes/admin.judging.routes.js  (mounted at /api/admin)
// RESULTS — rank-aggregation model. Each judge ranks the group by their own
// totals; a participant's PLACEMENT is by the SUM of the three judges' ranks
// (lowest wins), ties broken by the briefing order (C1 totals, then C2 …) and
// flagged. GRADE (A/B/C) is by the average score % (separate from placement).
// Divergence flagged when a participant's ranks differ across judges beyond the
// threshold (rule #7). Two-stage: finalise (print) then Chairman publish (#13).
// Rule #8 tiebreaker: when a placement tie cannot be broken by criteria order,
// the Chairman UNLOCKS a tiebreaker session and each judge gives a 1–10 mark per
// tied participant (Admin keys them in). The mark totals are the FINAL tiebreak.
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
            divergence_threshold_pct, no_prize_below, min_entries_threshold
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

// Per-participant sum of the judges' LATEST tiebreaker marks (rule #8). A fresh
// unlock supersedes earlier marks for the same (participant, judge), so we take
// the mark from the highest unlock_id per pair, then sum across judges.
async function tiebreakMarkSums(eventId) {
  const { rows } = await pool.query(
    `SELECT tm.participant_reg_id AS reg, SUM(tm.mark)::int AS s
     FROM tiebreaker_marks tm
     JOIN (SELECT participant_reg_id, judge_id, MAX(unlock_id) AS mu
           FROM tiebreaker_marks WHERE event_id = $1
           GROUP BY participant_reg_id, judge_id) l
       ON l.participant_reg_id = tm.participant_reg_id
      AND l.judge_id = tm.judge_id AND l.mu = tm.unlock_id
     WHERE tm.event_id = $1
     GROUP BY tm.participant_reg_id`, [eventId]);
  const m = {};
  for (const x of rows) m[x.reg] = Number(x.s);
  return m;
}

// Live computation for one (event, age group). Returns meta + per-participant rows.
async function computeGroup(eventId, ageGroupId, cfg) {
  const { rows: participants } = await pool.query(
    `SELECT r.id AS registration_id, ca.chest_number
     FROM registrations r JOIN chest_assignments ca ON ca.registration_id = r.id
     WHERE r.event_id = $1 AND r.age_group_id = $2 AND r.status = 'attended'
     ORDER BY ca.chest_number`, [eventId, ageGroupId]);
  const { rows: judges } = await pool.query(
    `SELECT ja.id AS assignment_id, ja.judge_id, j.full_name FROM judge_assignments ja
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
  const tbMark = await tiebreakMarkSums(eventId); // reg -> mark total (higher wins tie)

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
    return { registration_id: reg, chest_number: p.chest_number, perJudge, rankSum,
      avgPct: Math.round(avgPct * 100) / 100, divergence, critTotals, grade, tbMark: tbMark[reg] || 0 };
  });

  // placement: rankSum asc, tiebreak by critTotals (C1..) desc, then rule #8 marks desc
  const ordered = [...rows].sort((a, b) => {
    if (a.rankSum !== b.rankSum) return a.rankSum - b.rankSum;
    for (let i = 0; i < a.critTotals.length; i++) if (b.critTotals[i] !== a.critTotals[i]) return b.critTotals[i] - a.critTotals[i];
    if (b.tbMark !== a.tbMark) return b.tbMark - a.tbMark;
    return 0;
  });
  const rankSumCount = {};
  rows.forEach((r) => { rankSumCount[r.rankSum] = (rankSumCount[r.rankSum] || 0) + 1; });
  // Prize eligibility (two-tier): fewer than no_prize_below entries → no prizes;
  // fewer than min_entries_threshold → 1st & 2nd only; at/above → full top 3.
  const noPrizeBelow = Number(cfg.no_prize_below) || 0;
  const minEntriesFull = Number(cfg.min_entries_threshold) || 0;
  const n = participants.length;
  const prizeCap = n < noPrizeBelow ? 0 : (minEntriesFull && n < minEntriesFull ? 2 : 3);
  const maxPlaces = Math.min(prizeCap, n);

  // Unresolved EXACT ties: identical rankSum AND identical criteria totals AND equal
  // tiebreaker marks — the automatic tiebreak cannot separate them. Only matters when
  // the cluster touches a prize position (rule #8 tiebreaker needed there).
  const keyOf = (r) => `${r.rankSum}|${r.critTotals.join(',')}|${r.tbMark}`;
  const clusterCount = {}, clusterMinIdx = {};
  ordered.forEach((r, i) => { const k = keyOf(r); clusterCount[k] = (clusterCount[k] || 0) + 1; if (!(k in clusterMinIdx)) clusterMinIdx[k] = i; });

  ordered.forEach((r, i) => {
    r.place = i < maxPlaces ? i + 1 : null;
    r.tie = rankSumCount[r.rankSum] > 1;
    const k = keyOf(r);
    r.exactTie = clusterCount[k] > 1;
    r.needsTiebreak = r.exactTie && clusterMinIdx[k] < maxPlaces; // cluster reaches a prize place
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
    judge_meta: judges.map((j) => ({ judge_id: j.judge_id, name: j.full_name })),
    criteria, participant_count: participants.length,
    complete, divergence_threshold_pct: Number(cfg.divergence_threshold_pct), absolute_threshold: absThresh,
    prize_cap: prizeCap, no_prize_below: noPrizeBelow, min_entries_threshold: minEntriesFull,
    tiebreak_needed: ordered.some((r) => r.needsTiebreak),
    results: ordered.map((r) => ({
      registration_id: r.registration_id, chest_number: r.chest_number, per_judge: r.perJudge,
      rank_sum: r.rankSum, avg_pct: r.avgPct, place: r.place, grade: r.grade,
      tie_flag: r.tie, divergence_flag: r.divergence,
      exact_tie: r.exactTie, needs_tiebreak: r.needsTiebreak, mark_sum: r.tbMark,
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
    // merge stored divergence review notes + extra/consolation prizes (rule #14)
    const regIds = data.results.map((r) => r.registration_id);
    if (regIds.length) {
      const { rows: stored } = await pool.query(
        `SELECT registration_id, divergence_notes, extra_prize_type FROM event_results WHERE registration_id = ANY($1)`, [regIds]);
      const noteMap = new Map(stored.map((x) => [x.registration_id, x.divergence_notes]));
      const extraMap = new Map(stored.map((x) => [x.registration_id, x.extra_prize_type]));
      data.results.forEach((r) => {
        r.divergence_notes = noteMap.get(r.registration_id) || null;
        r.extra_prize_type = extraMap.get(r.registration_id) || null;
      });
    }
    res.json({ ...data, event: ev[0] || null, state: await groupState(req.params.event_id, req.params.age_group_id) });
  } catch (err) { next(err); }
});

// ── POST /api/admin/results/:event_id/:age_group_id/divergence — review note ──
router.post('/results/:event_id/:age_group_id/divergence', requireRole(...viewRoles), async (req, res, next) => {
  try {
    const { registration_id, note } = req.body;
    if (!registration_id) return res.status(400).json({ error: 'registration_id required' });
    const { rows: reg } = await pool.query(`SELECT event_id FROM registrations WHERE id = $1`, [registration_id]);
    if (!reg[0]) return res.status(404).json({ error: 'Registration not found' });
    await pool.query(
      `INSERT INTO event_results (registration_id, event_id, divergence_flag, divergence_notes)
       VALUES ($1,$2,TRUE,$3)
       ON CONFLICT (registration_id) DO UPDATE SET divergence_notes = EXCLUDED.divergence_notes, updated_at = NOW()
       WHERE event_results.is_published = FALSE`,
      [registration_id, reg[0].event_id, (note || '').trim() || null]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'REVIEW_DIVERGENCE', entity: 'event_results', entityId: registration_id, details: { note } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/admin/results/:event_id/:age_group_id/extra-prize (rule #14) ───
// Chairman-only "4th place" additional/consolation prize, addable only BEFORE
// Stage 2 publication and carrying NO rank points. Pass extra_prize_type = null
// to remove it. The DB trigger fn_check_extra_prize_window enforces the window;
// the CHECK constraint requires extra_prize_approved_by whenever a type is set.
const EXTRA_TYPES = ['additional_3rd', 'consolation'];
router.post('/results/:event_id/:age_group_id/extra-prize', requireRole(...viewRoles), async (req, res, next) => {
  try {
    if (req.user.role !== 'Chairman') {
      return res.status(403).json({ error: 'Only the Chairman may award an extra/consolation prize (rule #14).' });
    }
    const { registration_id } = req.body;
    let { extra_prize_type } = req.body;
    if (!registration_id) return res.status(400).json({ error: 'registration_id required' });
    if (extra_prize_type === '' || extra_prize_type === undefined) extra_prize_type = null;
    if (extra_prize_type !== null && !EXTRA_TYPES.includes(extra_prize_type)) {
      return res.status(400).json({ error: `extra_prize_type must be one of ${EXTRA_TYPES.join(', ')} or null.` });
    }
    const eventId = Number(req.params.event_id), ag = Number(req.params.age_group_id);
    const st = await groupState(eventId, ag);
    if (st.published) return res.status(409).json({ error: 'Results already published — extra prizes must be added before publishing (rule #14).' });

    const { rows: reg } = await pool.query(
      `SELECT r.event_id, er.prize_place, er.id AS result_id
       FROM registrations r LEFT JOIN event_results er ON er.registration_id = r.id
       WHERE r.id = $1`, [registration_id]);
    if (!reg[0]) return res.status(404).json({ error: 'Registration not found' });
    if (extra_prize_type !== null && reg[0].prize_place) {
      return res.status(409).json({ error: 'This chest already holds a main prize place — an extra prize is for non-winners.' });
    }

    // ensure a row exists (compute usually created it), then set the type + approver
    await pool.query(
      `INSERT INTO event_results (registration_id, event_id, extra_prize_type, extra_prize_approved_by, rank_points)
       VALUES ($1,$2,$3,$4,0)
       ON CONFLICT (registration_id) DO UPDATE SET
         extra_prize_type = EXCLUDED.extra_prize_type,
         extra_prize_approved_by = CASE WHEN EXCLUDED.extra_prize_type IS NULL THEN NULL ELSE EXCLUDED.extra_prize_approved_by END,
         updated_at = NOW()
       WHERE event_results.is_published = FALSE`,
      [registration_id, reg[0].event_id, extra_prize_type, extra_prize_type === null ? null : req.user.id]);

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: extra_prize_type ? 'AWARD_EXTRA_PRIZE' : 'REMOVE_EXTRA_PRIZE',
      entity: 'event_results', entityId: registration_id, details: { extra_prize_type, age_group_id: ag } });
    res.json({ ok: true, extra_prize_type });
  } catch (err) { next(err); }
});

// ── POST /api/admin/results/:event_id/:age_group_id/tiebreak/unlock (rule #8) ─
// Only a Chairman may authorise a tiebreaker session (the DB trigger enforces the
// same). Returns the unlock_id used to key in the judges' 1–10 marks.
router.post('/results/:event_id/:age_group_id/tiebreak/unlock', requireRole(...viewRoles), async (req, res, next) => {
  try {
    if (req.user.role !== 'Chairman') {
      return res.status(403).json({ error: 'Only the Chairman may unlock a tiebreaker session (rule #8).' });
    }
    const eventId = Number(req.params.event_id), ag = Number(req.params.age_group_id);
    const st = await groupState(eventId, ag);
    if (st.published) return res.status(409).json({ error: 'Results already published — cannot open a tiebreaker.' });
    const { rows } = await pool.query(
      `INSERT INTO tiebreaker_unlocks (event_id, unlocked_by) VALUES ($1, $2) RETURNING id`,
      [eventId, req.user.id]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'UNLOCK_TIEBREAKER', entity: 'events', entityId: eventId, details: { age_group_id: ag, unlock_id: rows[0].id } });
    res.json({ unlock_id: rows[0].id });
  } catch (err) { next(err); }
});

// ── POST /api/admin/results/:event_id/:age_group_id/tiebreak/marks (rule #8) ──
// Admin keys in the judges' 1–10 marks under the Chairman-authorised session, then
// the session is locked. Marks feed the final tiebreak on the next compute.
router.post('/results/:event_id/:age_group_id/tiebreak/marks', requireRole(...viewRoles), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const eventId = Number(req.params.event_id);
    const { unlock_id, marks } = req.body;
    if (!unlock_id || !Array.isArray(marks) || !marks.length) {
      return res.status(400).json({ error: 'unlock_id and a non-empty marks array are required' });
    }
    // validate the session belongs to this event and is still open
    const { rows: sess } = await pool.query(
      `SELECT id, locked_at FROM tiebreaker_unlocks WHERE id = $1 AND event_id = $2`, [unlock_id, eventId]);
    if (!sess[0]) return res.status(404).json({ error: 'Tiebreaker session not found for this event.' });
    if (sess[0].locked_at) return res.status(409).json({ error: 'This tiebreaker session is already locked.' });
    for (const m of marks) {
      const mk = Number(m.mark);
      if (!m.registration_id || !m.judge_id || !Number.isInteger(mk) || mk < 1 || mk > 10) {
        return res.status(400).json({ error: 'Each mark needs registration_id, judge_id and an integer mark 1–10.' });
      }
    }
    await client.query('BEGIN');
    for (const m of marks) {
      await client.query(
        `INSERT INTO tiebreaker_marks
           (event_id, participant_reg_id, judge_id, mark, unlock_id, entered_by, approved_by_chairman)
         VALUES ($1,$2,$3,$4,$5,$6,
                 (SELECT unlocked_by FROM tiebreaker_unlocks WHERE id = $5))
         ON CONFLICT (participant_reg_id, judge_id, unlock_id)
           DO UPDATE SET mark = EXCLUDED.mark, entered_by = EXCLUDED.entered_by, entered_at = NOW()`,
        [eventId, m.registration_id, m.judge_id, Number(m.mark), unlock_id, req.user.id]);
    }
    await client.query(`UPDATE tiebreaker_unlocks SET locked_at = NOW() WHERE id = $1`, [unlock_id]);
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'ENTER_TIEBREAKER_MARKS', entity: 'events', entityId: eventId, details: { unlock_id, count: marks.length } });
    res.json({ saved: marks.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
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
    // unresolved exact ties in prize positions need rule #8 tiebreaker marks first
    if (data.tiebreak_needed) {
      return res.status(409).json({ error: 'A placement tie could not be broken by criteria — resolve it with a tiebreaker (rule #8) before finalising.' });
    }
    // diverging results need a Chairman review note first (rule #7)
    const divergent = data.results.filter((r) => r.divergence_flag).map((r) => r.registration_id);
    if (divergent.length) {
      const { rows: notes } = await pool.query(
        `SELECT registration_id, divergence_notes FROM event_results WHERE registration_id = ANY($1)`, [divergent]);
      const noteMap = new Map(notes.map((x) => [x.registration_id, x.divergence_notes]));
      const unreviewed = divergent.filter((id) => !noteMap.get(id));
      if (unreviewed.length) return res.status(409).json({ error: `${unreviewed.length} diverging result(s) need a Chairman review note before finalising.` });
    }
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

// ── GET /results/:event_id/:age_group_id/sheet — official printable sheet ─────
// Full ranked list (name + chest), grades, points, extra prizes, judges &
// branding for the signed result sheet (rule #13 Stage-1 print). This is the
// internal official record, so it DOES show names (unlike the judge portal).
router.get('/results/:event_id/:age_group_id/sheet', requireRole(...viewRoles), async (req, res, next) => {
  try {
    const cfg = await activeCfg();
    if (!cfg) return res.status(400).json({ error: 'No active year' });
    const eventId = Number(req.params.event_id), ag = Number(req.params.age_group_id);
    const data = await computeGroup(eventId, ag, cfg);

    const { rows: brand } = await pool.query(
      `SELECT event_year_label, kca_logo_url, sponsor_logo_url, sponsor_name
       FROM year_config WHERE is_active = TRUE LIMIT 1`);
    const { rows: ev } = await pool.query(
      `SELECT e.event_code, e.event_name, c.name AS category_name,
              ag.label AS age_group_label, ag.code AS age_group_code
       FROM events e LEFT JOIN categories c ON c.id = e.category_id
       LEFT JOIN age_groups ag ON ag.id = $2 WHERE e.id = $1`, [eventId, ag]);

    const regIds = data.results.map((r) => r.registration_id);
    const nameMap = new Map(), schoolMap = new Map(), extraMap = new Map();
    if (regIds.length) {
      const { rows: names } = await pool.query(
        `SELECT r.id, COALESCE(p.full_name, t.team_name) AS name, s.name AS school
         FROM registrations r
         LEFT JOIN participants p ON p.id = r.participant_id
         LEFT JOIN teams t ON t.id = r.team_id
         LEFT JOIN schools s ON s.id = COALESCE(p.school_id, t.school_id)
         WHERE r.id = ANY($1)`, [regIds]);
      names.forEach((x) => { nameMap.set(x.id, x.name); schoolMap.set(x.id, x.school); });
      const { rows: extra } = await pool.query(
        `SELECT registration_id, extra_prize_type FROM event_results WHERE registration_id = ANY($1)`, [regIds]);
      extra.forEach((x) => extraMap.set(x.registration_id, x.extra_prize_type));
    }
    // data.results is already in ranked (placement) order
    const results = data.results.map((r, i) => ({
      order: i + 1, place: r.place, chest_number: r.chest_number,
      name: nameMap.get(r.registration_id) || null, school: schoolMap.get(r.registration_id) || null,
      rank_sum: r.rank_sum, avg_pct: r.avg_pct, grade: r.grade,
      rank_points: r.rank_points, grade_points: r.grade_points,
      participation_bonus_pts: r.participation_bonus_pts, total_points: r.total_points,
      extra_prize_type: extraMap.get(r.registration_id) || null,
    }));
    res.json({
      branding: brand[0] || null, event: ev[0] || null,
      judges: data.judge_meta || [], participant_count: data.participant_count,
      complete: data.complete, state: await groupState(eventId, ag),
      generated_at: new Date().toISOString(), results,
    });
  } catch (err) { next(err); }
});

module.exports = router;

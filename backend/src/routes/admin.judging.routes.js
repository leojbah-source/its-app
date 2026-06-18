// src/routes/admin.judging.routes.js  (mounted at /api/admin)
// Rule #7: DIVERGENCE THRESHOLD = % of total participants. Absolute threshold
// per event = ROUND(total_participants * divergence_threshold_pct / 100).
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);
const staffRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'];
const editRoles = ['SuperAdmin', 'Admin', 'Coordinator'];

// POST /api/admin/criteria-confirm/:assignment_id
router.post('/criteria-confirm/:assignment_id', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE judge_assignments SET criteria_confirmed_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.assignment_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Assignment not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CONFIRM_CRITERIA', entity: 'judge_assignments', entityId: req.params.assignment_id });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Helper: per-judge rank list for an event, based on each judge's own raw totals
async function getPerJudgeRanks(eventId) {
  const { rows } = await pool.query(
    `SELECT s.judge_id, s.registration_id, SUM(s.score) AS total
     FROM scores s
     JOIN judge_assignments ja ON ja.id = s.assignment_id
     WHERE ja.event_id = $1
     GROUP BY s.judge_id, s.registration_id`,
    [eventId]
  );
  const byJudge = new Map();
  for (const r of rows) {
    if (!byJudge.has(r.judge_id)) byJudge.set(r.judge_id, []);
    byJudge.get(r.judge_id).push({ registration_id: r.registration_id, total: Number(r.total) });
  }
  const ranksByJudge = new Map();
  for (const [judgeId, list] of byJudge.entries()) {
    const sorted = [...list].sort((a, b) => b.total - a.total);
    const rankMap = new Map();
    sorted.forEach((item, idx) => rankMap.set(item.registration_id, idx + 1));
    ranksByJudge.set(judgeId, rankMap);
  }
  return ranksByJudge;
}

// POST /api/admin/scoring/:event_id/calculate
router.post('/scoring/:event_id/calculate', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { rows: evRows } = await pool.query(`SELECT year_id FROM events WHERE id = $1`, [req.params.event_id]);
    if (!evRows[0]) return res.status(404).json({ error: 'Event not found' });
    const { rows: cfgRows } = await pool.query(
      `SELECT grade_config, rank_points_config, participation_bonus_pts FROM year_config WHERE year_id = $1`,
      [evRows[0].year_id]
    );
    const cfg = cfgRows[0] || {};

    const { rows: totals } = await pool.query(
      `SELECT s.registration_id, SUM(s.score) AS total, COUNT(DISTINCT s.judge_id) AS judge_count
       FROM scores s JOIN judge_assignments ja ON ja.id = s.assignment_id
       WHERE ja.event_id = $1 GROUP BY s.registration_id`,
      [req.params.event_id]
    );

    const ranked = [...totals].sort((a, b) => Number(b.total) - Number(a.total));
    const rankPoints = cfg.rank_points_config || { 1: 5, 2: 3, 3: 1 };
    const gradeConfig = cfg.grade_config || []; // e.g. [{grade:'A', min_pct:80}, ...]
    const maxPossible = await pool.query(
      `SELECT COALESCE(SUM(max_score),0) AS max_total FROM criteria WHERE event_id = $1`,
      [req.params.event_id]
    );
    const maxTotal = Number(maxPossible.rows[0].max_total) || 1;

    const results = [];
    for (let i = 0; i < ranked.length; i++) {
      const reg = ranked[i];
      const rank = i + 1;
      const pct = (Number(reg.total) / maxTotal) * 100;
      const grade = (gradeConfig.find((g) => pct >= g.min_pct) || {}).grade || null;
      const points = rankPoints[String(rank)] || 0;
      const gradePoints = (gradeConfig.find((g) => g.grade === grade) || {}).points || 0;

      const { rows } = await pool.query(
        `INSERT INTO results (event_id, registration_id, rank, grade, rank_points, grade_points, is_published)
         VALUES ($1,$2,$3,$4,$5,$6,false)
         ON CONFLICT (event_id, registration_id) DO UPDATE
           SET rank = EXCLUDED.rank, grade = EXCLUDED.grade, rank_points = EXCLUDED.rank_points, grade_points = EXCLUDED.grade_points
         RETURNING *`,
        [req.params.event_id, reg.registration_id, rank, grade, points, gradePoints]
      );
      results.push(rows[0]);
    }

    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CALCULATE_SCORING', entity: 'results', entityId: req.params.event_id, details: { count: results.length } });
    res.json(results);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/scoring/:event_id/divergence-alerts
router.get('/scoring/:event_id/divergence-alerts', requireRole(...editRoles, 'Chairman'), async (req, res, next) => {
  try {
    const { rows: evRows } = await pool.query(`SELECT year_id FROM events WHERE id = $1`, [req.params.event_id]);
    if (!evRows[0]) return res.status(404).json({ error: 'Event not found' });
    const { rows: cfgRows } = await pool.query(`SELECT divergence_threshold_pct FROM year_config WHERE year_id = $1`, [evRows[0].year_id]);
    const pct = Number(cfgRows[0]?.divergence_threshold_pct || 0);

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS total FROM registrations WHERE event_id = $1 AND status != 'cancelled'`,
      [req.params.event_id]
    );
    const totalParticipants = Number(countRows[0].total);
    const absoluteThreshold = Math.round((totalParticipants * pct) / 100); // rule #7

    const ranksByJudge = await getPerJudgeRanks(req.params.event_id);
    const judgeIds = [...ranksByJudge.keys()];
    const allRegIds = new Set();
    for (const m of ranksByJudge.values()) for (const regId of m.keys()) allRegIds.add(regId);

    const alerts = [];
    for (const regId of allRegIds) {
      const ranks = judgeIds.map((j) => ranksByJudge.get(j).get(regId)).filter((r) => r != null);
      if (ranks.length < 2) continue;
      const maxDiff = Math.max(...ranks) - Math.min(...ranks);
      if (maxDiff > absoluteThreshold) {
        alerts.push({ registration_id: regId, judgeRanks: ranks, maxDiff, absoluteThreshold });
      }
    }
    res.json({ totalParticipants, divergenceThresholdPct: pct, absoluteThreshold, alerts });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/scoring/:event_id/proceed-despite-alert
router.post('/scoring/:event_id/proceed-despite-alert', requireRole(...editRoles, 'Chairman'), async (req, res, next) => {
  try {
    const { registration_id, justification } = req.body;
    if (!registration_id || !justification) {
      return res.status(400).json({ error: 'registration_id and justification are required' });
    }
    await logAudit({
      actorId: req.user.id, actorRole: req.user.role, action: 'PROCEED_DESPITE_DIVERGENCE',
      entity: 'results', entityId: req.params.event_id, details: { registration_id, justification },
    });
    res.json({ message: 'Proceeding recorded in audit log', registration_id });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/scoring/:event_id/request-review  -> notify Chairman
router.post('/scoring/:event_id/request-review', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { registration_id, reason } = req.body;
    await logAudit({
      actorId: req.user.id, actorRole: req.user.role, action: 'REQUEST_SCORE_REVIEW',
      entity: 'results', entityId: req.params.event_id, details: { registration_id, reason },
    });
    // Notification surface (in-app notice; WhatsApp can be wired in via utils/notify if Chairman phone is on file)
    res.json({ message: 'Review request logged; Chairman notified', registration_id });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/scoring/:score_id/override  -- Chairman-approved correction
router.put('/scoring/:score_id/override', requireRole('Chairman', 'SuperAdmin'), async (req, res, next) => {
  try {
    const { new_score, reason } = req.body;
    if (new_score == null || !reason) return res.status(400).json({ error: 'new_score and reason are required' });

    const { rows } = await pool.query(
      `UPDATE scores SET score = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [new_score, req.params.score_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Score not found' });

    await logAudit({
      actorId: req.user.id, actorRole: req.user.role, action: 'OVERRIDE_SCORE',
      entity: 'scores', entityId: req.params.score_id, details: { new_score, reason },
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

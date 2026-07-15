// src/routes/judge.routes.js  (mounted at /api/judge)
// Judge-facing scoring. Rule #5: judges see CHEST NUMBERS ONLY, never names.
// Bare scoring for now — no criteria-confirmation gate, no live ranking yet.
//
// Real schema (verified):
//   scores(id, judge_assignment_id, registration_id, criterion_id, score_value,
//     entered_by, entered_at, updated_at,
//     UNIQUE(judge_assignment_id, registration_id, criterion_id))
//   event_criteria(id, event_id, criterion_name, max_score, sequence_order)
//   v_judge_scoring_board(registration_id, event_id, time_slot_id, chest_number)
//     — attended participants only; the ONLY thing a judge screen may read.
const express = require('express');
const pool = require('../db');
const { authenticate, requireType } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate, requireType('judge'));

async function loadOwnAssignment(assignmentId, judgeId) {
  const { rows } = await pool.query(
    `SELECT id, judge_id, event_id, time_slot_id FROM judge_assignments
     WHERE id = $1 AND judge_id = $2`, [assignmentId, judgeId]);
  return rows[0] || null;
}

// ── GET /api/judge/events — this judge's assigned events + progress ──────────
router.get('/events', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ja.id AS assignment_id, e.id AS event_id, e.event_code, e.event_name,
              c.name AS category_name,
              (SELECT COUNT(*)::int FROM v_judge_scoring_board b WHERE b.event_id = e.id) AS participant_count,
              (SELECT COUNT(DISTINCT s.registration_id)::int FROM scores s
               WHERE s.judge_assignment_id = ja.id) AS scored_count
       FROM judge_assignments ja
       JOIN events e ON e.id = ja.event_id
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE ja.judge_id = $1
       ORDER BY e.event_code`, [req.user.judgeId]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/judge/sheet/:assignment_id — criteria + chest list + my scores ──
router.get('/sheet/:assignment_id', async (req, res, next) => {
  try {
    const asg = await loadOwnAssignment(req.params.assignment_id, req.user.judgeId);
    if (!asg) return res.status(404).json({ error: 'Assignment not found' });

    const { rows: ev } = await pool.query(
      `SELECT e.id, e.event_code, e.event_name, c.name AS category_name
       FROM events e LEFT JOIN categories c ON c.id = e.category_id WHERE e.id = $1`, [asg.event_id]);
    const { rows: criteria } = await pool.query(
      `SELECT id, criterion_name AS label, max_score, sequence_order
       FROM event_criteria WHERE event_id = $1 ORDER BY sequence_order, id`, [asg.event_id]);
    // CHEST NUMBERS ONLY — never participants/registrations directly (rule #5).
    const { rows: participants } = await pool.query(
      `SELECT registration_id, chest_number FROM v_judge_scoring_board
       WHERE event_id = $1 ORDER BY chest_number`, [asg.event_id]);
    const { rows: scores } = await pool.query(
      `SELECT registration_id, criterion_id, score_value FROM scores
       WHERE judge_assignment_id = $1`, [asg.id]);

    res.json({ assignment_id: asg.id, event: ev[0] || null, criteria, participants, scores });
  } catch (err) { next(err); }
});

// ── POST /api/judge/scores/:assignment_id — save/update scores ───────────────
// body: { scores: [{ registration_id, criterion_id, score_value }] }
router.post('/scores/:assignment_id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const asg = await loadOwnAssignment(req.params.assignment_id, req.user.judgeId);
    if (!asg) return res.status(404).json({ error: 'Assignment not found' });
    const list = req.body?.scores;
    if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: 'scores array is required' });

    // Valid criteria (id → max) and valid chest-board registrations for this event.
    const { rows: crit } = await client.query(
      `SELECT id, max_score FROM event_criteria WHERE event_id = $1`, [asg.event_id]);
    const maxByCrit = new Map(crit.map((c) => [c.id, Number(c.max_score)]));
    const { rows: board } = await client.query(
      `SELECT registration_id FROM v_judge_scoring_board WHERE event_id = $1`, [asg.event_id]);
    const validRegs = new Set(board.map((b) => b.registration_id));

    for (const s of list) {
      if (!maxByCrit.has(s.criterion_id)) return res.status(400).json({ error: `Criterion ${s.criterion_id} is not part of this event` });
      if (!validRegs.has(s.registration_id)) return res.status(400).json({ error: `Chest/registration ${s.registration_id} is not on this event's scoring board` });
      const v = Number(s.score_value);
      if (Number.isNaN(v) || v < 0 || v > maxByCrit.get(s.criterion_id))
        return res.status(400).json({ error: `Score for criterion ${s.criterion_id} must be between 0 and ${maxByCrit.get(s.criterion_id)}` });
    }

    await client.query('BEGIN');
    let saved = 0;
    for (const s of list) {
      await client.query(
        `INSERT INTO scores (judge_assignment_id, registration_id, criterion_id, score_value, entered_by, updated_at)
         VALUES ($1,$2,$3,$4,$5, NOW())
         ON CONFLICT (judge_assignment_id, registration_id, criterion_id)
           DO UPDATE SET score_value = EXCLUDED.score_value, entered_by = EXCLUDED.entered_by, updated_at = NOW()`,
        [asg.id, s.registration_id, s.criterion_id, Number(s.score_value), req.user.judgeId]);
      saved++;
    }
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.judgeId, actorRole: 'Judge',
      action: 'ENTER_SCORES', entity: 'scores', entityId: asg.id, details: { saved } });
    res.status(201).json({ saved });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

module.exports = router;

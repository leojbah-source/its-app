// src/routes/judge.routes.js  (mounted at /api/judge)
// Rule #5: judges see CHEST NUMBERS ONLY, never participant names.
// Rule #6: live ranking is visible only to the scoring judge as they enter scores.
const express = require('express');
const pool = require('../db');
const { authenticate, requireType } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate, requireType('judge'));

// Helper: confirms the assignment belongs to the authenticated judge
async function loadOwnAssignment(assignmentId, judgeId) {
  const { rows } = await pool.query(
    `SELECT * FROM judge_assignments WHERE id = $1 AND judge_id = $2`,
    [assignmentId, judgeId]
  );
  return rows[0] || null;
}

// GET /api/judge/events  -- this judge's assigned events
router.get('/events', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ja.id AS assignment_id, ja.status, e.id AS event_id, e.name, e.category, e.age_group
       FROM judge_assignments ja JOIN events e ON e.id = ja.event_id
       WHERE ja.judge_id = $1 ORDER BY e.id`,
      [req.user.judgeId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/judge/briefing/:assignment_id
router.get('/briefing/:assignment_id', async (req, res, next) => {
  try {
    const assignment = await loadOwnAssignment(req.params.assignment_id, req.user.judgeId);
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

    const { rows: eventRows } = await pool.query(`SELECT * FROM events WHERE id = $1`, [assignment.event_id]);
    const { rows: criteriaRows } = await pool.query(
      `SELECT id, name, max_score, sort_order FROM criteria WHERE event_id = $1 ORDER BY sort_order`,
      [assignment.event_id]
    );
    res.json({ event: eventRows[0], criteria: criteriaRows });
  } catch (err) {
    next(err);
  }
});

// GET /api/judge/sheet/:assignment_id  -- CHEST # ONLY (rule #5)
router.get('/sheet/:assignment_id', async (req, res, next) => {
  try {
    const assignment = await loadOwnAssignment(req.params.assignment_id, req.user.judgeId);
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

    const { rows: criteriaRows } = await pool.query(
      `SELECT id, name, max_score FROM criteria WHERE event_id = $1 ORDER BY sort_order`,
      [assignment.event_id]
    );
    const { rows: chestRows } = await pool.query(
      `SELECT cn.registration_id, cn.chest_number FROM chest_numbers cn
       WHERE cn.event_id = $1 ORDER BY cn.chest_number`,
      [assignment.event_id]
    );

    res.json({
      assignmentId: assignment.id,
      criteria: criteriaRows,
      // Deliberately exposes chest_number only - no child_name, no school, no other PII.
      participants: chestRows.map((c) => ({ registrationRef: c.registration_id, chestNumber: c.chest_number })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/judge/scores/:assignment_id
router.post('/scores/:assignment_id', async (req, res, next) => {
  try {
    const assignment = await loadOwnAssignment(req.params.assignment_id, req.user.judgeId);
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
    if (!assignment.criteria_confirmed_at) {
      return res.status(403).json({ error: 'Criteria must be confirmed by the Admin before scoring' });
    }

    const { scores } = req.body; // [{ registration_id, criterion_id, score }]
    if (!Array.isArray(scores) || scores.length === 0) {
      return res.status(400).json({ error: 'scores array is required' });
    }

    const saved = [];
    for (const s of scores) {
      const { rows: critRows } = await pool.query(`SELECT max_score FROM criteria WHERE id = $1`, [s.criterion_id]);
      if (!critRows[0]) continue;
      if (s.score < 0 || s.score > critRows[0].max_score) {
        return res.status(400).json({ error: `Score for criterion ${s.criterion_id} must be between 0 and ${critRows[0].max_score}` });
      }
      const { rows } = await pool.query(
        `INSERT INTO scores (assignment_id, judge_id, registration_id, criterion_id, score, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5, NOW(), NOW())
         ON CONFLICT (assignment_id, registration_id, criterion_id) DO UPDATE
           SET score = EXCLUDED.score, updated_at = NOW()
         RETURNING *`,
        [assignment.id, req.user.judgeId, s.registration_id, s.criterion_id, s.score]
      );
      saved.push(rows[0]);
    }
    res.status(201).json(saved);
  } catch (err) {
    next(err);
  }
});

// GET /api/judge/live-ranking/:assignment_id  -- this judge's current rankings only (rule #6)
router.get('/live-ranking/:assignment_id', async (req, res, next) => {
  try {
    const assignment = await loadOwnAssignment(req.params.assignment_id, req.user.judgeId);
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

    const { rows } = await pool.query(
      `SELECT s.registration_id, cn.chest_number, SUM(s.score) AS total_score
       FROM scores s
       JOIN chest_numbers cn ON cn.registration_id = s.registration_id AND cn.event_id = $1
       WHERE s.assignment_id = $2 AND s.judge_id = $3
       GROUP BY s.registration_id, cn.chest_number
       ORDER BY total_score DESC`,
      [assignment.event_id, assignment.id, req.user.judgeId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/judge/scores/:id/revision-response  -- {accepts: bool, statement: string}
router.post('/scores/:id/revision-response', async (req, res, next) => {
  try {
    const { accepts, statement } = req.body;
    if (typeof accepts !== 'boolean') return res.status(400).json({ error: 'accepts (boolean) is required' });

    if (accepts === false) {
      if (!statement) return res.status(400).json({ error: 'statement is required when refusing a revision' });
      await pool.query(
        `INSERT INTO judge_flags (assignment_id, judge_id, statement, created_at)
         VALUES ($1,$2,$3, NOW())`,
        [req.params.id, req.user.judgeId, statement]
      );
      // notify Chairman per Master Context rule #9
      await logAudit({ actorId: req.user.judgeId, actorRole: 'Judge', action: 'REFUSE_REVISION', entity: 'judge_flags', entityId: req.params.id, details: { statement } });
      return res.json({ message: 'Refusal recorded; Chairman has been notified' });
    }

    await logAudit({ actorId: req.user.judgeId, actorRole: 'Judge', action: 'ACCEPT_REVISION', entity: 'scores', entityId: req.params.id });
    res.json({ message: 'Revision accepted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

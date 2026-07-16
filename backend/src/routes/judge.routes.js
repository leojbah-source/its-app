// src/routes/judge.routes.js  (mounted at /api/judge)
// Judge-facing scoring. Rule #5: judges see CHEST NUMBERS ONLY, never names.
// Scoping is per AGE GROUP (chest numbers restart at 1 per group). Panel agrees
// criteria weightages (sum 100) on the day; weightages lock once scoring starts.
//
// Real schema (verified):
//   scores(id, judge_assignment_id, registration_id, criterion_id, score_value,
//     entered_by, entered_at, updated_at,
//     UNIQUE(judge_assignment_id, registration_id, criterion_id))
//   event_criteria(id, event_id, criterion_name, max_score, sequence_order)
//     — trg_event_criteria_check enforces the max_score values sum to 100.
//   chest_assignments(registration_id, chest_number, age_group_id, ...)
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
async function eventScored(eventId) {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM scores s JOIN registrations r ON r.id = s.registration_id
                    WHERE r.event_id = $1) AS x`, [eventId]);
  return rows[0].x;
}

// ── GET /api/judge/events — this judge's assigned events ─────────────────────
router.get('/events', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ja.id AS assignment_id, e.id AS event_id, e.event_code, e.event_name,
              c.name AS category_name,
              (SELECT COUNT(*)::int FROM event_criteria ec WHERE ec.event_id = e.id) AS criteria_count,
              (SELECT COALESCE(SUM(ec.max_score),0)::int FROM event_criteria ec WHERE ec.event_id = e.id) AS criteria_total
       FROM judge_assignments ja
       JOIN events e ON e.id = ja.event_id
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE ja.judge_id = $1
       ORDER BY e.event_code`, [req.user.judgeId]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/judge/events/:assignment_id/groups — groups with chest lists ─────
router.get('/events/:assignment_id/groups', async (req, res, next) => {
  try {
    const asg = await loadOwnAssignment(req.params.assignment_id, req.user.judgeId);
    if (!asg) return res.status(404).json({ error: 'Assignment not found' });
    const { rows } = await pool.query(
      `SELECT ag.id AS age_group_id, ag.code, ag.label, ag.sort_order,
              COUNT(DISTINCT ca.registration_id)::int AS participant_count,
              COUNT(DISTINCT s.registration_id)::int AS scored_count
       FROM registrations r
       JOIN age_groups ag ON ag.id = r.age_group_id
       JOIN chest_assignments ca ON ca.registration_id = r.id
       LEFT JOIN scores s ON s.registration_id = r.id AND s.judge_assignment_id = $2
       WHERE r.event_id = $1 AND r.status = 'attended'
       GROUP BY ag.id, ag.code, ag.label, ag.sort_order
       ORDER BY ag.sort_order, ag.code`, [asg.event_id, asg.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/judge/sheet/:assignment_id?age_group_id= — one group's sheet ────
router.get('/sheet/:assignment_id', async (req, res, next) => {
  try {
    const asg = await loadOwnAssignment(req.params.assignment_id, req.user.judgeId);
    if (!asg) return res.status(404).json({ error: 'Assignment not found' });
    const ag = req.query.age_group_id ? Number(req.query.age_group_id) : null;
    if (!ag) return res.status(400).json({ error: 'age_group_id is required' });

    const { rows: ev } = await pool.query(
      `SELECT e.id, e.event_code, e.event_name, c.name AS category_name,
              ag.code AS age_group_code, ag.label AS age_group_label
       FROM events e LEFT JOIN categories c ON c.id = e.category_id
       LEFT JOIN age_groups ag ON ag.id = $2
       WHERE e.id = $1`, [asg.event_id, ag]);
    const { rows: criteria } = await pool.query(
      `SELECT id, criterion_name AS label, max_score, sequence_order
       FROM event_criteria WHERE event_id = $1 ORDER BY sequence_order, id`, [asg.event_id]);
    // CHEST NUMBERS ONLY (rule #5), scoped to this group.
    const { rows: participants } = await pool.query(
      `SELECT r.id AS registration_id, ca.chest_number
       FROM registrations r JOIN chest_assignments ca ON ca.registration_id = r.id
       WHERE r.event_id = $1 AND r.age_group_id = $2 AND r.status = 'attended'
       ORDER BY ca.chest_number`, [asg.event_id, ag]);
    const { rows: scores } = await pool.query(
      `SELECT s.registration_id, s.criterion_id, s.score_value FROM scores s
       JOIN registrations r ON r.id = s.registration_id
       WHERE s.judge_assignment_id = $1 AND r.age_group_id = $2`, [asg.id, ag]);

    res.json({
      assignment_id: asg.id,
      event: ev[0] || null,
      age_group_id: ag,
      criteria,
      weightages_locked: await eventScored(asg.event_id),
      weightage_total: criteria.reduce((t, c) => t + Number(c.max_score), 0),
      participants,
      scores,
    });
  } catch (err) { next(err); }
});

// ── POST /api/judge/criteria/:assignment_id — set/agree weightages (sum 100) ──
// body: { criteria: [{ id, max_score, sequence_order }] }
router.post('/criteria/:assignment_id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const asg = await loadOwnAssignment(req.params.assignment_id, req.user.judgeId);
    if (!asg) return res.status(404).json({ error: 'Assignment not found' });
    if (await eventScored(asg.event_id))
      return res.status(409).json({ error: 'Scoring has started — criteria weightages can no longer be changed.' });

    const list = req.body?.criteria;
    if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: 'criteria array is required' });
    const { rows: owned } = await client.query(`SELECT id FROM event_criteria WHERE event_id = $1`, [asg.event_id]);
    const ownedIds = new Set(owned.map((c) => c.id));
    let sum = 0;
    for (const c of list) {
      if (!ownedIds.has(c.id)) return res.status(400).json({ error: `Criterion ${c.id} is not part of this event` });
      const m = Number(c.max_score);
      if (Number.isNaN(m) || m <= 0) return res.status(400).json({ error: 'Each weightage must be a positive number' });
      sum += m;
    }
    if (Math.round(sum) !== 100) return res.status(400).json({ error: `Weightages must total 100 (currently ${sum}).` });

    await client.query('BEGIN');
    for (const c of list) {
      await client.query(
        `UPDATE event_criteria SET max_score = $1, sequence_order = $2 WHERE id = $3 AND event_id = $4`,
        [Number(c.max_score), Number(c.sequence_order) || 1, c.id, asg.event_id]);
    }
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.judgeId, actorRole: 'Judge',
      action: 'SET_CRITERIA_WEIGHTAGES', entity: 'events', entityId: asg.event_id, details: { criteria: list } });
    const { rows: criteria } = await client.query(
      `SELECT id, criterion_name AS label, max_score, sequence_order
       FROM event_criteria WHERE event_id = $1 ORDER BY sequence_order, id`, [asg.event_id]);
    res.json({ criteria });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
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

    const { rows: crit } = await client.query(
      `SELECT id, max_score FROM event_criteria WHERE event_id = $1`, [asg.event_id]);
    const maxByCrit = new Map(crit.map((c) => [c.id, Number(c.max_score)]));
    // Valid = attended entries with a chest number in this event.
    const { rows: valid } = await client.query(
      `SELECT r.id FROM registrations r JOIN chest_assignments ca ON ca.registration_id = r.id
       WHERE r.event_id = $1 AND r.status = 'attended'`, [asg.event_id]);
    const validRegs = new Set(valid.map((v) => v.id));

    for (const s of list) {
      if (!maxByCrit.has(s.criterion_id)) return res.status(400).json({ error: `Criterion ${s.criterion_id} is not part of this event` });
      if (!validRegs.has(s.registration_id)) return res.status(400).json({ error: `Chest/registration ${s.registration_id} is not scorable (attendance + chest required)` });
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

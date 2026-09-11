// src/routes/judge.routes.js  (mounted at /api/judge)
// Judge-facing scoring. Rule #5: judges see CHEST NUMBERS ONLY, never names.
// Scoping is per AGE GROUP (chest numbers restart at 1 per group). Each age
// group agrees its OWN criteria weightages (sum 100) on the day and may set
// different weightage values from other groups of the same event (migration
// 030: event_criteria_weightages); weightages lock once that group's scoring
// starts, and edits lock once the group's result is published.
//
// Real schema (verified):
//   scores(id, judge_assignment_id, registration_id, criterion_id, score_value,
//     entered_by, entered_at, updated_at,
//     UNIQUE(judge_assignment_id, registration_id, criterion_id))
//   event_criteria(id, event_id, criterion_name, max_score, sequence_order)
//     — event-level DEFAULT weightages; trg_event_criteria_check enforces sum 100.
//   event_criteria_weightages(event_id, age_group_id, criterion_id, max_score,
//     sequence_order) — per-age-group OVERRIDE; trg_ecw_check enforces sum 100.
//   chest_assignments(registration_id, chest_number, age_group_id, ...)
const express = require('express');
const pool = require('../db');
const { authenticate, requireType } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate, requireType('judge'));

// Single active session: a judge's token carries a `sid`. Only the session that
// matches judges.active_session is valid; any other screen is signed out here.
// (A second login is blocked outright in auth.routes verify-otp, so normally the
// first/only session stays valid; this also signs out an old screen after an
// admin reset + fresh login.)
router.use(async (req, res, next) => {
  try {
    if (!req.user?.sid) return next(); // legacy token (pre-feature) — allow
    const { rows } = await pool.query(`SELECT active_session FROM judges WHERE id = $1`, [req.user.judgeId]);
    if (rows[0] && rows[0].active_session && rows[0].active_session !== req.user.sid) {
      return res.status(401).json({ error: 'SESSION_SUPERSEDED', message: 'Signed out — this judge signed in on another screen.' });
    }
    next();
  } catch (e) { next(e); }
});

async function loadOwnAssignment(assignmentId, judgeId) {
  const { rows } = await pool.query(
    `SELECT id, judge_id, event_id, age_group_id, time_slot_id FROM judge_assignments
     WHERE id = $1 AND judge_id = $2`, [assignmentId, judgeId]);
  return rows[0] || null;
}

// Effective criteria for a (event, age group): the per-age-group weightage
// override where set, else the event-level default. C1..Cn order follows the
// group's own sequence_order.
async function effectiveCriteria(eventId, ageGroupId) {
  const { rows } = await pool.query(
    `SELECT ec.id, ec.criterion_name AS label,
            COALESCE(w.max_score, ec.max_score)           AS max_score,
            COALESCE(w.sequence_order, ec.sequence_order) AS sequence_order
     FROM event_criteria ec
     LEFT JOIN event_criteria_weightages w
       ON w.criterion_id = ec.id AND w.event_id = ec.event_id AND w.age_group_id = $2
     WHERE ec.event_id = $1
     ORDER BY COALESCE(w.sequence_order, ec.sequence_order), ec.id`, [eventId, ageGroupId]);
  return rows;
}

// Has scoring started for THIS (event, age group)? Locks its weightages.
async function groupScored(eventId, ageGroupId) {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM scores s JOIN registrations r ON r.id = s.registration_id
                    WHERE r.event_id = $1 AND r.age_group_id = $2) AS x`, [eventId, ageGroupId]);
  return rows[0].x;
}

// Finalise / publish state for a (event, age group) — across all attended entries.
async function groupResultState(eventId, ageGroupId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE er.is_finalised)::int AS finalised,
            COUNT(*) FILTER (WHERE er.is_published)::int AS published
     FROM registrations r
     LEFT JOIN event_results er ON er.registration_id = r.id
     WHERE r.event_id = $1 AND r.age_group_id = $2 AND r.status = 'attended'`, [eventId, ageGroupId]);
  const s = rows[0];
  return { finalised: s.n > 0 && s.finalised === s.n, published: s.n > 0 && s.published === s.n };
}

// Weightage agreement across this (event + age group)'s judges only.
async function agreementStatus(eventId, ageGroupId, myAssignmentId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(weightages_agreed_at)::int AS agreed,
            bool_or(id = $3 AND weightages_agreed_at IS NOT NULL) AS i_agreed
     FROM judge_assignments WHERE event_id = $1 AND age_group_id = $2`, [eventId, ageGroupId, myAssignmentId]);
  const r = rows[0];
  return { total: r.total, agreed: r.agreed, i_agreed: !!r.i_agreed, all_agreed: r.total > 0 && r.agreed === r.total };
}

// "Done scoring" status across this (event + age group)'s judges.
async function doneStatus(eventId, ageGroupId, myAssignmentId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total, COUNT(scoring_done_at)::int AS done,
            bool_or(id = $3 AND scoring_done_at IS NOT NULL) AS i_done
     FROM judge_assignments WHERE event_id = $1 AND age_group_id = $2`, [eventId, ageGroupId, myAssignmentId]);
  const r = rows[0];
  return { total: r.total, done: r.done, i_done: !!r.i_done, all_done: r.total > 0 && r.done === r.total };
}

// ── GET /api/judge/events — this judge's assigned events ─────────────────────
// Each row is one (event, age group) assignment, with per-group progress flags
// so the portal can mark which are already scored / finalised / published.
router.get('/events', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ja.id AS assignment_id, e.id AS event_id, e.event_code, e.event_name,
              c.name AS category_name,
              ja.age_group_id, ag.code AS age_group_code, ag.label AS age_group_label,
              (e.id = j.active_event_id) AS is_active,
              (ja.scoring_done_at IS NOT NULL) AS scoring_done,
              (SELECT COUNT(*) > 0 AND COUNT(*) FILTER (WHERE er.is_finalised) = COUNT(*)
               FROM registrations r LEFT JOIN event_results er ON er.registration_id = r.id
               WHERE r.event_id = e.id AND r.age_group_id = ja.age_group_id AND r.status = 'attended') AS finalised,
              (SELECT COUNT(*) > 0 AND COUNT(*) FILTER (WHERE er.is_published) = COUNT(*)
               FROM registrations r LEFT JOIN event_results er ON er.registration_id = r.id
               WHERE r.event_id = e.id AND r.age_group_id = ja.age_group_id AND r.status = 'attended') AS published,
              (SELECT COUNT(*)::int FROM event_criteria ec WHERE ec.event_id = e.id) AS criteria_count,
              (SELECT COALESCE(SUM(ec.max_score),0)::int FROM event_criteria ec WHERE ec.event_id = e.id) AS criteria_total
       FROM judge_assignments ja
       JOIN events e ON e.id = ja.event_id
       JOIN judges j ON j.id = ja.judge_id
       LEFT JOIN categories c ON c.id = e.category_id
       LEFT JOIN age_groups ag ON ag.id = ja.age_group_id
       WHERE ja.judge_id = $1
       ORDER BY (e.id = j.active_event_id) DESC NULLS LAST, e.event_code, ag.sort_order`, [req.user.judgeId]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/judge/briefing/:assignment_id — event briefing (criteria+agree) ──
router.get('/briefing/:assignment_id', async (req, res, next) => {
  try {
    const asg = await loadOwnAssignment(req.params.assignment_id, req.user.judgeId);
    if (!asg) return res.status(404).json({ error: 'Assignment not found' });
    const { rows: ev } = await pool.query(
      `SELECT e.event_code, e.event_name, c.name AS category_name,
              e.allotted_time_seconds, e.grace_period_seconds, e.yellow_alert_seconds, e.is_stage_event,
              ag.code AS age_group_code, ag.label AS age_group_label
       FROM events e LEFT JOIN categories c ON c.id = e.category_id
       LEFT JOIN age_groups ag ON ag.id = $2
       WHERE e.id = $1`, [asg.event_id, asg.age_group_id]);
    res.json({
      assignment_id: asg.id, event: ev[0] || null,
      age_group_id: asg.age_group_id,
      criteria: await effectiveCriteria(asg.event_id, asg.age_group_id),
      weightages_locked: await groupScored(asg.event_id, asg.age_group_id),
      agreement: await agreementStatus(asg.event_id, asg.age_group_id, asg.id),
      result_state: await groupResultState(asg.event_id, asg.age_group_id),
    });
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
       WHERE r.event_id = $1 AND r.status = 'attended' AND ag.id = $3
       GROUP BY ag.id, ag.code, ag.label, ag.sort_order
       ORDER BY ag.sort_order, ag.code`, [asg.event_id, asg.id, asg.age_group_id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/judge/sheet/:assignment_id?age_group_id= — one group's sheet ────
router.get('/sheet/:assignment_id', async (req, res, next) => {
  try {
    const asg = await loadOwnAssignment(req.params.assignment_id, req.user.judgeId);
    if (!asg) return res.status(404).json({ error: 'Assignment not found' });
    // The assignment IS a single age group now — always score that group.
    const ag = asg.age_group_id || (req.query.age_group_id ? Number(req.query.age_group_id) : null);
    if (!ag) return res.status(400).json({ error: 'assignment has no age group' });

    const { rows: ev } = await pool.query(
      `SELECT e.id, e.event_code, e.event_name, c.name AS category_name,
              ag.code AS age_group_code, ag.label AS age_group_label
       FROM events e LEFT JOIN categories c ON c.id = e.category_id
       LEFT JOIN age_groups ag ON ag.id = $2
       WHERE e.id = $1`, [asg.event_id, ag]);
    const criteria = await effectiveCriteria(asg.event_id, ag);
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
      weightages_locked: await groupScored(asg.event_id, ag),
      weightage_total: criteria.reduce((t, c) => t + Number(c.max_score), 0),
      agreement: await agreementStatus(asg.event_id, asg.age_group_id, asg.id),
      done: await doneStatus(asg.event_id, asg.age_group_id, asg.id),
      result_state: await groupResultState(asg.event_id, ag),
      participants,
      scores,
    });
  } catch (err) { next(err); }
});

// ── POST /api/judge/criteria/:assignment_id — set/agree weightages (sum 100) ──
// Per AGE GROUP: writes this group's weightage override (event_criteria_weightages).
// body: { criteria: [{ id, max_score, sequence_order }] }
router.post('/criteria/:assignment_id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const asg = await loadOwnAssignment(req.params.assignment_id, req.user.judgeId);
    if (!asg) return res.status(404).json({ error: 'Assignment not found' });
    if (!asg.age_group_id) return res.status(400).json({ error: 'assignment has no age group' });
    if (await groupScored(asg.event_id, asg.age_group_id))
      return res.status(409).json({ error: 'Scoring has started for this age group — criteria weightages can no longer be changed.' });

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
    // Replace this age group's override set. DELETE + INSERT avoids the transient
    // UNIQUE(event_id, age_group_id, sequence_order) collision when C1..Cn reorder.
    await client.query(`DELETE FROM event_criteria_weightages WHERE event_id = $1 AND age_group_id = $2`, [asg.event_id, asg.age_group_id]);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      await client.query(
        `INSERT INTO event_criteria_weightages (event_id, age_group_id, criterion_id, max_score, sequence_order, updated_at)
         VALUES ($1,$2,$3,$4,$5, NOW())`,
        [asg.event_id, asg.age_group_id, c.id, Number(c.max_score), Number(c.sequence_order) || (i + 1)]);
    }
    // Changing THIS group's weightages resets agreement for this age group only;
    // the proposer auto-agrees.
    await client.query(`UPDATE judge_assignments SET weightages_agreed_at = NULL WHERE event_id = $1 AND age_group_id = $2`, [asg.event_id, asg.age_group_id]);
    await client.query(`UPDATE judge_assignments SET weightages_agreed_at = NOW() WHERE id = $1`, [asg.id]);
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.judgeId, actorRole: 'Judge',
      action: 'SET_CRITERIA_WEIGHTAGES', entity: 'events', entityId: asg.event_id, details: { age_group_id: asg.age_group_id, criteria: list } });
    res.json({ criteria: await effectiveCriteria(asg.event_id, asg.age_group_id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── POST /api/judge/criteria/:assignment_id/agree — this judge agrees ────────
router.post('/criteria/:assignment_id/agree', async (req, res, next) => {
  try {
    const asg = await loadOwnAssignment(req.params.assignment_id, req.user.judgeId);
    if (!asg) return res.status(404).json({ error: 'Assignment not found' });
    await pool.query(`UPDATE judge_assignments SET weightages_agreed_at = NOW() WHERE id = $1`, [asg.id]);
    await logAudit({ actorId: req.user.judgeId, actorRole: 'Judge',
      action: 'AGREE_WEIGHTAGES', entity: 'judge_assignments', entityId: asg.id });
    res.json({ agreement: await agreementStatus(asg.event_id, asg.age_group_id, asg.id) });
  } catch (err) { next(err); }
});

// ── POST /api/judge/scores/:assignment_id — save/update scores ───────────────
// body: { scores: [{ registration_id, criterion_id, score_value }] }
router.post('/scores/:assignment_id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const asg = await loadOwnAssignment(req.params.assignment_id, req.user.judgeId);
    if (!asg) return res.status(404).json({ error: 'Assignment not found' });
    const state = await groupResultState(asg.event_id, asg.age_group_id);
    if (state.published)
      return res.status(409).json({ error: 'Results are published — scores are locked and can no longer be changed.' });
    const agree = await agreementStatus(asg.event_id, asg.age_group_id, asg.id);
    if (!agree.all_agreed)
      return res.status(409).json({ error: `All ${agree.total} judges of this age group must agree the criteria weightages before scoring (${agree.agreed}/${agree.total} agreed).` });
    const list = req.body?.scores;
    if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: 'scores array is required' });

    // Effective (per-age-group) weightage caps.
    const crit = await effectiveCriteria(asg.event_id, asg.age_group_id);
    const maxByCrit = new Map(crit.map((c) => [c.id, Number(c.max_score)]));
    // Valid = attended entries with a chest number in this event.
    const { rows: valid } = await client.query(
      `SELECT r.id FROM registrations r JOIN chest_assignments ca ON ca.registration_id = r.id
       WHERE r.event_id = $1 AND r.age_group_id = $2 AND r.status = 'attended'`, [asg.event_id, asg.age_group_id]);
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

// ── POST /api/judge/done/:assignment_id — mark this judge's scoring finished ──
router.post('/done/:assignment_id', async (req, res, next) => {
  try {
    const asg = await loadOwnAssignment(req.params.assignment_id, req.user.judgeId);
    if (!asg) return res.status(404).json({ error: 'Assignment not found' });
    const { rows: cc } = await pool.query(`SELECT COUNT(*)::int AS n FROM event_criteria WHERE event_id = $1`, [asg.event_id]);
    const { rows: pc } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM registrations r JOIN chest_assignments ca ON ca.registration_id = r.id
       WHERE r.event_id = $1 AND r.age_group_id = $2 AND r.status = 'attended'`, [asg.event_id, asg.age_group_id]);
    const { rows: scc } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM scores s JOIN registrations r ON r.id = s.registration_id
       WHERE s.judge_assignment_id = $1 AND r.age_group_id = $2`, [asg.id, asg.age_group_id]);
    if (pc[0].n === 0) return res.status(400).json({ error: 'No participants to score yet.' });
    const expected = cc[0].n * pc[0].n;
    if (scc[0].n < expected)
      return res.status(400).json({ error: `Score every chest on every criterion first (${scc[0].n}/${expected} entered).` });
    await pool.query(`UPDATE judge_assignments SET scoring_done_at = NOW() WHERE id = $1`, [asg.id]);
    await logAudit({ actorId: req.user.judgeId, actorRole: 'Judge', action: 'SCORING_DONE', entity: 'judge_assignments', entityId: asg.id });
    res.json({ done: await doneStatus(asg.event_id, asg.age_group_id, asg.id) });
  } catch (err) { next(err); }
});

// ── POST /api/judge/done/:assignment_id/undo — reopen scoring for edits ───────
// Blocked once the group's result is PUBLISHED (scores become view-only).
router.post('/done/:assignment_id/undo', async (req, res, next) => {
  try {
    const asg = await loadOwnAssignment(req.params.assignment_id, req.user.judgeId);
    if (!asg) return res.status(404).json({ error: 'Assignment not found' });
    const state = await groupResultState(asg.event_id, asg.age_group_id);
    if (state.published)
      return res.status(409).json({ error: 'Results are published — scoring is locked and can no longer be reopened.' });
    await pool.query(`UPDATE judge_assignments SET scoring_done_at = NULL WHERE id = $1`, [asg.id]);
    await logAudit({ actorId: req.user.judgeId, actorRole: 'Judge', action: 'SCORING_REOPEN', entity: 'judge_assignments', entityId: asg.id });
    res.json({ done: await doneStatus(asg.event_id, asg.age_group_id, asg.id) });
  } catch (err) { next(err); }
});

// ── POST /api/judge/logout — end this judge's active session ──────────────────
// Frees the single-session lock so the judge can sign in again (see auth.routes).
router.post('/logout', async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE judges SET active_session = NULL, active_session_at = NULL
       WHERE id = $1 AND (active_session = $2 OR $2 IS NULL)`,
      [req.user.judgeId, req.user.sid || null]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;

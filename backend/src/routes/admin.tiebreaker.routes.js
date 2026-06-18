// src/routes/admin.tiebreaker.routes.js  (mounted at /api/admin/tiebreaker)
// Rule #8: EXACT TIE -> Chairman convenes judges for a tiebreaker mark (1-10
// per judge per participant). Requires Chairman role to unlock/submit.
// Fully logged via audit_log (insert-only).
//
// `sub_group` identifies a tied cluster within an event - in this
// implementation it is the tied total-score value shared by 2+ registrations
// (e.g. two participants both totalling 87 points and contesting the same rank).
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

// GET /api/admin/tiebreaker/:event_id/:sub_group  -- tied participants + mark status
router.get('/:event_id/:sub_group', requireRole('SuperAdmin', 'Admin', 'Coordinator', 'Chairman'), async (req, res, next) => {
  try {
    const tiedTotal = Number(req.params.sub_group);

    const { rows: tied } = await pool.query(
      `SELECT s.registration_id, SUM(s.score) AS total
       FROM scores s JOIN judge_assignments ja ON ja.id = s.assignment_id
       WHERE ja.event_id = $1
       GROUP BY s.registration_id
       HAVING SUM(s.score) = $2`,
      [req.params.event_id, tiedTotal]
    );
    if (tied.length < 2) {
      return res.status(404).json({ error: 'No tied cluster found for this event/sub_group' });
    }

    const { rows: assignedJudges } = await pool.query(
      `SELECT DISTINCT judge_id FROM judge_assignments WHERE event_id = $1`,
      [req.params.event_id]
    );
    const { rows: marks } = await pool.query(
      `SELECT * FROM tiebreaker_marks WHERE event_id = $1 AND sub_group = $2`,
      [req.params.event_id, req.params.sub_group]
    );

    res.json({
      eventId: req.params.event_id,
      subGroup: req.params.sub_group,
      tiedParticipants: tied,
      requiredJudges: assignedJudges.map((j) => j.judge_id),
      marksEntered: marks,
      isComplete: marks.length >= tied.length * assignedJudges.length,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/tiebreaker/:event_id/:sub_group/marks  -- requires Chairman role
router.post('/:event_id/:sub_group/marks', requireRole('Chairman'), async (req, res, next) => {
  try {
    const { marks } = req.body; // [{ judge_id, participant_reg_id, mark }]
    if (!Array.isArray(marks) || marks.length === 0) {
      return res.status(400).json({ error: 'marks array is required' });
    }
    for (const m of marks) {
      if (m.mark < 1 || m.mark > 10) {
        return res.status(400).json({ error: 'Each tiebreaker mark must be between 1 and 10' });
      }
    }

    const saved = [];
    for (const m of marks) {
      const { rows } = await pool.query(
        `INSERT INTO tiebreaker_marks (event_id, sub_group, judge_id, registration_id, mark, created_at)
         VALUES ($1,$2,$3,$4,$5, NOW())
         ON CONFLICT (event_id, sub_group, judge_id, registration_id) DO UPDATE SET mark = EXCLUDED.mark
         RETURNING *`,
        [req.params.event_id, req.params.sub_group, m.judge_id, m.participant_reg_id, m.mark]
      );
      saved.push(rows[0]);
    }

    await logAudit({
      actorId: req.user.id, actorRole: req.user.role, action: 'ENTER_TIEBREAKER_MARKS',
      entity: 'tiebreaker_marks', entityId: req.params.event_id,
      details: { sub_group: req.params.sub_group, marks },
    });
    res.status(201).json(saved);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/tiebreaker/:event_id/:sub_group/resolve  -- re-rank with tiebreaker marks
router.post('/:event_id/:sub_group/resolve', requireRole('Chairman', 'SuperAdmin'), async (req, res, next) => {
  try {
    const { rows: marks } = await pool.query(
      `SELECT registration_id, SUM(mark) AS tb_total FROM tiebreaker_marks
       WHERE event_id = $1 AND sub_group = $2
       GROUP BY registration_id ORDER BY tb_total DESC`,
      [req.params.event_id, req.params.sub_group]
    );
    if (marks.length === 0) return res.status(400).json({ error: 'No tiebreaker marks recorded yet for this sub_group' });

    // Determine the rank position this tied cluster currently occupies, then
    // re-assign ranks within the cluster by descending tiebreaker total.
    const { rows: currentRanks } = await pool.query(
      `SELECT rank FROM results WHERE event_id = $1 AND registration_id = $2`,
      [req.params.event_id, marks[0].registration_id]
    );
    const baseRank = currentRanks[0]?.rank || 1;

    const updated = [];
    for (let i = 0; i < marks.length; i++) {
      const { rows } = await pool.query(
        `UPDATE results SET rank = $1 WHERE event_id = $2 AND registration_id = $3 RETURNING *`,
        [baseRank + i, req.params.event_id, marks[i].registration_id]
      );
      updated.push(rows[0]);
    }

    await logAudit({
      actorId: req.user.id, actorRole: req.user.role, action: 'RESOLVE_TIEBREAKER',
      entity: 'results', entityId: req.params.event_id,
      details: { sub_group: req.params.sub_group, resolvedOrder: marks.map((m) => m.registration_id) },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

// src/routes/admin.awards.routes.js  (mounted at /api/admin/awards)
// Rule #15: Group Championship = ONE award per age group (gender-agnostic).
// Rule #16: school awards = SUM(rank_points + grade_points + participation_bonus_pts) per school.
// Rule #24: Awards screen is Chairman role ONLY.
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate, requireRole('Chairman'));

// GET /api/admin/awards/:year_id/standings
router.get('/:year_id/standings', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM awards WHERE year_id = $1 ORDER BY type, points DESC`, [req.params.year_id]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/awards/:year_id/standings  -- manual standing entry/override
router.post('/:year_id/standings', async (req, res, next) => {
  try {
    const { type, scope, winner_ref, label, points } = req.body;
    if (!type || !scope || !winner_ref) return res.status(400).json({ error: 'type, scope and winner_ref are required' });
    const { rows } = await pool.query(
      `INSERT INTO awards (year_id, type, scope, winner_ref, label, points, created_at)
       VALUES ($1,$2,$3,$4,$5,$6, NOW()) RETURNING *`,
      [req.params.year_id, type, scope, winner_ref, label || null, points || 0]
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'ADD_AWARD_STANDING', entity: 'awards', entityId: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/awards/:year_id/calculate
router.post('/:year_id/calculate', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM awards WHERE year_id = $1 AND type IN ('group_championship', 'school_award')`, [req.params.year_id]);

    const { rows: cfgRows } = await client.query(`SELECT participation_bonus_pts FROM year_config WHERE year_id = $1`, [req.params.year_id]);
    const participationBonus = Number(cfgRows[0]?.participation_bonus_pts || 0);

    // --- Group Championship: one per age_group, gender-agnostic (rule #15) ---
    const { rows: ageGroupTotals } = await client.query(
      `SELECT c.age_group, r.id AS reg_id, c.name AS child_name,
              SUM(res.rank_points + res.grade_points) AS points
       FROM results res
       JOIN registrations r ON r.id = res.registration_id
       JOIN children c ON c.id = r.child_id
       WHERE r.year_id = $1
       GROUP BY c.age_group, r.id, c.name`,
      [req.params.year_id]
    );
    const bestPerAgeGroup = new Map();
    for (const row of ageGroupTotals) {
      const current = bestPerAgeGroup.get(row.age_group);
      if (!current || Number(row.points) > Number(current.points)) bestPerAgeGroup.set(row.age_group, row);
    }
    const championships = [];
    for (const [ageGroup, winner] of bestPerAgeGroup.entries()) {
      const { rows } = await client.query(
        `INSERT INTO awards (year_id, type, scope, winner_ref, label, points, created_at)
         VALUES ($1,'group_championship','age_group',$2,$3,$4, NOW()) RETURNING *`,
        [req.params.year_id, winner.reg_id, `${ageGroup} Group Champion - ${winner.child_name}`, winner.points]
      );
      championships.push(rows[0]);
    }

    // --- School awards: SUM(rank_points + grade_points + participation_bonus_pts) per school (rule #16) ---
    const { rows: schoolRows } = await client.query(
      `SELECT c.school,
              SUM(res.rank_points + res.grade_points + $2::numeric) AS total_points
       FROM results res
       JOIN registrations r ON r.id = res.registration_id
       JOIN children c ON c.id = r.child_id
       WHERE r.year_id = $1 AND c.school IS NOT NULL
       GROUP BY c.school ORDER BY total_points DESC`,
      [req.params.year_id, participationBonus]
    );
    const schoolAwards = [];
    for (const row of schoolRows) {
      const { rows } = await client.query(
        `INSERT INTO awards (year_id, type, scope, winner_ref, label, points, created_at)
         VALUES ($1,'school_award','school',$2,$3,$4, NOW()) RETURNING *`,
        [req.params.year_id, row.school, row.school, row.total_points]
      );
      schoolAwards.push(rows[0]);
    }

    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CALCULATE_AWARDS', entity: 'awards', entityId: req.params.year_id, details: { championships: championships.length, schoolAwards: schoolAwards.length } });
    res.json({ championships, schoolAwards });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/admin/awards/:year_id/export
router.get('/:year_id/export', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM awards WHERE year_id = $1 ORDER BY type, points DESC`, [req.params.year_id]);
    const header = 'id,type,scope,winner_ref,label,points,created_at';
    const csv = [header, ...rows.map((r) =>
      [r.id, r.type, r.scope, r.winner_ref, r.label, r.points, r.created_at]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="awards_${req.params.year_id}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

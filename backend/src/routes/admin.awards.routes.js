// src/routes/admin.awards.routes.js  (mounted at /api/admin/awards)
// Rule #15: Group Championship = ONE award per age group (gender-agnostic).
// Rule #16: school awards = SUM(rank_points + grade_points + participation_bonus_pts) per school.
// Rule #24: Awards screen is Chairman-only (SuperAdmin allowed as system owner).
//
// Computed LIVE from the schema views (v_school_award_totals / v_group_championship),
// which aggregate FINALISED results (Stage 1). No separate `awards` table.
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireRole('Chairman', 'SuperAdmin'));

async function resolveYearId(param) {
  if (param && param !== 'active') return Number(param);
  const { rows } = await pool.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
  return rows[0]?.id || null;
}

// GET /api/admin/awards/:year_id/standings   (year_id may be 'active')
router.get('/:year_id/standings', async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.params.year_id);
    if (!yearId) return res.status(400).json({ error: 'No active year' });

    const { rows: schoolAwards } = await pool.query(
      `SELECT school_id, school_name, total_rank_points, total_grade_points,
              total_participation_pts, grand_total
       FROM v_school_award_totals WHERE year_id = $1
       ORDER BY grand_total DESC NULLS LAST, school_name`, [yearId]);

    const { rows: groupChampionship } = await pool.query(
      `SELECT age_group_id, age_group_label, school_id, school_name, total_points
       FROM v_group_championship WHERE year_id = $1
       ORDER BY age_group_label, total_points DESC NULLS LAST`, [yearId]);

    res.json({ year_id: yearId, school_awards: schoolAwards, group_championship: groupChampionship });
  } catch (err) { next(err); }
});

// GET /api/admin/awards/:year_id/export  -> CSV (both tables stacked)
router.get('/:year_id/export', async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.params.year_id);
    if (!yearId) return res.status(400).json({ error: 'No active year' });
    const { rows: schools } = await pool.query(
      `SELECT school_name, total_rank_points, total_grade_points, total_participation_pts, grand_total
       FROM v_school_award_totals WHERE year_id = $1 ORDER BY grand_total DESC NULLS LAST`, [yearId]);
    const { rows: groups } = await pool.query(
      `SELECT age_group_label, school_name, total_points
       FROM v_group_championship WHERE year_id = $1 ORDER BY age_group_label, total_points DESC NULLS LAST`, [yearId]);
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [];
    lines.push('SCHOOL AWARDS (rule #16)');
    lines.push('school,rank_points,grade_points,participation_pts,grand_total');
    schools.forEach((r) => lines.push([r.school_name, r.total_rank_points, r.total_grade_points, r.total_participation_pts, r.grand_total].map(q).join(',')));
    lines.push('');
    lines.push('GROUP CHAMPIONSHIP (rule #15)');
    lines.push('age_group,school,total_points');
    groups.forEach((r) => lines.push([r.age_group_label, r.school_name, r.total_points].map(q).join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="awards_${yearId}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) { next(err); }
});

module.exports = router;

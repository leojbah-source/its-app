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

// Teacher Awards (rule #17): sum each named teacher's students' finalised total
// points across dance_teacher + music_teacher. 'NOT_APPLICABLE'/blank excluded.
const teacherSql = `
  SELECT teacher AS teacher_name, ROUND(SUM(pts)::numeric, 2) AS total_points, COUNT(*) AS entries
  FROM (
    SELECT TRIM(reg.dance_teacher) AS teacher, er.total_points AS pts
    FROM event_results er JOIN registrations reg ON reg.id = er.registration_id
    WHERE reg.year_id = $1 AND er.is_finalised = TRUE
      AND reg.dance_teacher IS NOT NULL AND reg.dance_teacher <> 'NOT_APPLICABLE' AND TRIM(reg.dance_teacher) <> ''
    UNION ALL
    SELECT TRIM(reg.music_teacher), er.total_points
    FROM event_results er JOIN registrations reg ON reg.id = er.registration_id
    WHERE reg.year_id = $1 AND er.is_finalised = TRUE
      AND reg.music_teacher IS NOT NULL AND reg.music_teacher <> 'NOT_APPLICABLE' AND TRIM(reg.music_teacher) <> ''
  ) t
  GROUP BY teacher
  ORDER BY total_points DESC NULLS LAST, teacher`;

// Top participants by TOTAL finalised points, within each age group (top 5,
// ties shown). Individual participants only (team entries excluded).
const ageGroupToppersSql = `
  SELECT * FROM (
    SELECT q.*, RANK() OVER (PARTITION BY q.age_group_id ORDER BY q.total_points DESC) AS rnk
    FROM (
      SELECT ag.id AS age_group_id, ag.label AS age_group_label, ag.code AS age_group_code, ag.sort_order,
             p.id AS participant_id, p.full_name, sch.name AS school,
             ROUND(SUM(er.total_points)::numeric, 2) AS total_points, COUNT(*)::int AS entries
      FROM event_results er
      JOIN registrations reg ON reg.id = er.registration_id
      JOIN participants p ON p.id = reg.participant_id
      JOIN age_groups ag ON ag.id = reg.age_group_id
      LEFT JOIN schools sch ON sch.id = p.school_id
      WHERE reg.year_id = $1 AND er.is_finalised = TRUE AND reg.participant_id IS NOT NULL
      GROUP BY ag.id, ag.label, ag.code, ag.sort_order, p.id, p.full_name, sch.name
    ) q
  ) r
  WHERE rnk <= 5
  ORDER BY sort_order NULLS LAST, rnk, full_name`;

// Overall top participants by TOTAL finalised points, within each event
// category across ALL age groups (top 5, ties shown). Individuals only.
const categoryToppersSql = `
  SELECT * FROM (
    SELECT q.*, RANK() OVER (PARTITION BY q.category_id ORDER BY q.total_points DESC) AS rnk
    FROM (
      SELECT c.id AS category_id, c.name AS category_name, c.sort_order,
             p.id AS participant_id, p.full_name, sch.name AS school,
             ROUND(SUM(er.total_points)::numeric, 2) AS total_points, COUNT(*)::int AS entries
      FROM event_results er
      JOIN registrations reg ON reg.id = er.registration_id
      JOIN participants p ON p.id = reg.participant_id
      JOIN events e ON e.id = reg.event_id
      JOIN categories c ON c.id = e.category_id
      LEFT JOIN schools sch ON sch.id = p.school_id
      WHERE reg.year_id = $1 AND er.is_finalised = TRUE AND reg.participant_id IS NOT NULL
      GROUP BY c.id, c.name, c.sort_order, p.id, p.full_name, sch.name
    ) q
  ) r
  WHERE rnk <= 5
  ORDER BY sort_order NULLS LAST, rnk, full_name`;

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

    const { rows: teacherAwards } = await pool.query(teacherSql, [yearId]);
    const { rows: ageGroupToppers } = await pool.query(ageGroupToppersSql, [yearId]);
    const { rows: categoryToppers } = await pool.query(categoryToppersSql, [yearId]);

    res.json({ year_id: yearId, school_awards: schoolAwards, group_championship: groupChampionship,
      teacher_awards: teacherAwards, age_group_toppers: ageGroupToppers, category_toppers: categoryToppers });
  } catch (err) { next(err); }
});

// GET /api/admin/awards/:year_id/teacher-entries?teacher=<name>
// View-only drill-down into one teacher's finalised entries: participant/team,
// event, age group, role (dance/music), prize and points — the rows that sum to
// the teacher's total.
router.get('/:year_id/teacher-entries', async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.params.year_id);
    if (!yearId) return res.status(400).json({ error: 'No active year' });
    const teacher = String(req.query.teacher || '').trim();
    if (!teacher) return res.status(400).json({ error: 'teacher query parameter is required' });
    const { rows } = await pool.query(
      `SELECT COALESCE(p.full_name, tm.team_name) AS entry_name,
              (reg.team_id IS NOT NULL) AS is_team,
              sch.name AS school,
              e.event_code, e.event_name, c.name AS category_name,
              ag.code AS age_group_code, ag.label AS age_group_label,
              er.prize_place, er.grade, er.total_points,
              CASE WHEN TRIM(COALESCE(reg.dance_teacher, '')) = $2 THEN 'Dance'
                   WHEN TRIM(COALESCE(reg.music_teacher, '')) = $2 THEN 'Music' END AS taught_as
         FROM event_results er
         JOIN registrations reg ON reg.id = er.registration_id
         JOIN events e ON e.id = reg.event_id
         LEFT JOIN categories c ON c.id = e.category_id
         LEFT JOIN age_groups ag ON ag.id = reg.age_group_id
         LEFT JOIN participants p ON p.id = reg.participant_id
         LEFT JOIN teams tm ON tm.id = reg.team_id
         LEFT JOIN schools sch ON sch.id = COALESCE(p.school_id, tm.school_id)
        WHERE reg.year_id = $1 AND er.is_finalised = TRUE
          AND ( (reg.dance_teacher <> 'NOT_APPLICABLE' AND TRIM(COALESCE(reg.dance_teacher, '')) = $2)
             OR (reg.music_teacher <> 'NOT_APPLICABLE' AND TRIM(COALESCE(reg.music_teacher, '')) = $2) )
        ORDER BY e.event_code, ag.sort_order NULLS LAST, entry_name`,
      [yearId, teacher]);
    res.json({ teacher, entries: rows });
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
    const { rows: teachers } = await pool.query(teacherSql, [yearId]);
    lines.push('');
    lines.push('TEACHER AWARDS (rule #17)');
    lines.push('teacher,entries,total_points');
    teachers.forEach((r) => lines.push([r.teacher_name, r.entries, r.total_points].map(q).join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="awards_${yearId}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) { next(err); }
});

module.exports = router;

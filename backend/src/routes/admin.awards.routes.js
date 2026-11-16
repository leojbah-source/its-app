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

// GET /api/admin/awards/:year_id/trophy-count  (year_id may be 'active')
// Trophies to procure.
//  Individual (projected maximum): for each individual event x age-group cell
//  that is going ahead (event not cancelled, cell not consolidation-cancelled),
//  project 1st/2nd/3rd capped by the number of entrants — a cell with 2 entrants
//  counts a 1st + 2nd only, a cell with 1 counts a 1st only. Active entrants =
//  status registered/attended. Also reports what is already DECIDED (published).
//  Teams: one trophy per team member (substitutes included) across every team
//  in non-cancelled team events.
router.get('/:year_id/trophy-count', async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.params.year_id);
    if (!yearId) return res.status(400).json({ error: 'No active year' });

    // Individual cells + entrant counts (projected max).
    const { rows: cells } = await pool.query(
      `SELECT r.event_id, r.age_group_id, COUNT(*)::int AS n,
              e.event_code, e.event_name, c.name AS category_name, c.sort_order AS cat_sort,
              ag.code AS age_group_code, ag.label AS age_group_label, ag.sort_order AS ag_sort,
              EXISTS (SELECT 1 FROM event_results er JOIN registrations r2 ON r2.id = er.registration_id
                       WHERE r2.event_id = r.event_id AND r2.age_group_id = r.age_group_id
                         AND er.is_published = TRUE) AS published
         FROM registrations r
         JOIN events e ON e.id = r.event_id
         LEFT JOIN categories c ON c.id = e.category_id
         LEFT JOIN age_groups ag ON ag.id = r.age_group_id
        WHERE r.year_id = $1 AND e.event_kind = 'individual' AND e.is_cancelled = FALSE
          AND r.participant_id IS NOT NULL
          AND r.status IN ('registered','attended')
          AND NOT EXISTS (SELECT 1 FROM event_consolidations x
                           WHERE x.kind = 'cancel' AND x.reverted_at IS NULL
                             AND x.source_event_ids[1] = r.event_id AND x.age_group_id = r.age_group_id)
        GROUP BY r.event_id, r.age_group_id, e.event_code, e.event_name, c.name, c.sort_order,
                 ag.code, ag.label, ag.sort_order
        ORDER BY cat_sort NULLS LAST, event_code, ag_sort NULLS LAST`, [yearId]);

    let first = 0, second = 0, third = 0, cellsPublished = 0;
    const cellRows = cells.map((r) => {
      if (r.n >= 1) first += 1;
      if (r.n >= 2) second += 1;
      if (r.n >= 3) third += 1;
      if (r.published) cellsPublished += 1;
      return {
        event_code: r.event_code, event_name: r.event_name,
        category_name: r.category_name, age_group_code: r.age_group_code,
        age_group_label: r.age_group_label, entrants: r.n,
        trophies: Math.min(3, r.n), published: !!r.published };
    });

    // Already DECIDED (published) individual places — catches ties (e.g. two 2nds).
    const { rows: decided } = await pool.query(
      `SELECT er.prize_place, COUNT(*)::int AS n
         FROM event_results er
         JOIN registrations r ON r.id = er.registration_id
         JOIN events e ON e.id = er.event_id
        WHERE r.year_id = $1 AND e.event_kind = 'individual' AND er.is_published = TRUE
          AND COALESCE(er.is_disqualified, FALSE) = FALSE AND er.prize_place IN (1,2,3)
        GROUP BY er.prize_place`, [yearId]);
    const dmap = { 1: 0, 2: 0, 3: 0 };
    for (const d of decided) dmap[d.prize_place] = d.n;
    const { rows: extras } = await pool.query(
      `SELECT er.extra_prize_type, COUNT(*)::int AS n
         FROM event_results er
         JOIN registrations r ON r.id = er.registration_id
         JOIN events e ON e.id = er.event_id
        WHERE r.year_id = $1 AND e.event_kind = 'individual' AND er.is_published = TRUE
          AND er.extra_prize_type IS NOT NULL
        GROUP BY er.extra_prize_type`, [yearId]);
    const extraMap = { additional_3rd: 0, consolation: 0 };
    for (const x of extras) extraMap[x.extra_prize_type] = x.n;

    // Teams — per (event x age group) contest, the top min(teams,3) teams win
    // (1 team -> 1st only; 2 -> 1st,2nd; 3+ -> top 3). Every member of a winning
    // team (substitutes included) gets a trophy. Projection takes the LARGEST
    // teams in each cell as the upper bound; 'decided' uses published placings.
    const { rows: teamRows } = await pool.query(
      `SELECT t.event_id, t.age_group_id, e.event_code, e.event_name,
              ag.code AS age_group_code, ag.sort_order AS ag_sort,
              t.id AS team_id, COUNT(tm.id)::int AS member_count
         FROM teams t
         JOIN events e ON e.id = t.event_id
         LEFT JOIN age_groups ag ON ag.id = t.age_group_id
         LEFT JOIN team_members tm ON tm.team_id = t.id
        WHERE t.year_id = $1 AND e.event_kind = 'team' AND e.is_cancelled = FALSE
        GROUP BY t.event_id, t.age_group_id, e.event_code, e.event_name, ag.code, ag.sort_order, t.id
        ORDER BY e.event_code, ag_sort NULLS LAST`, [yearId]);
    const teamCells = new Map();
    for (const r of teamRows) {
      const key = `${r.event_id}:${r.age_group_id}`;
      if (!teamCells.has(key)) teamCells.set(key, {
        event_code: r.event_code, event_name: r.event_name,
        age_group_code: r.age_group_code, sizes: [] });
      teamCells.get(key).sizes.push(r.member_count || 0);
    }
    let teamTrophies = 0, teamWinningTeams = 0, teamTotalTeams = 0;
    const teamCellRows = [];
    for (const cell of teamCells.values()) {
      const sizes = cell.sizes.slice().sort((a, b) => b - a);
      const winners = Math.min(sizes.length, 3);
      const trophies = sizes.slice(0, winners).reduce((a, b) => a + b, 0);
      teamTrophies += trophies; teamWinningTeams += winners; teamTotalTeams += sizes.length;
      teamCellRows.push({ event_code: cell.event_code, event_name: cell.event_name,
        age_group_code: cell.age_group_code, teams: sizes.length,
        winning_teams: winners, trophies });
    }
    // Decided (published) team trophies: members of teams actually placed 1-3.
    const { rows: tdec } = await pool.query(
      `SELECT COALESCE(SUM(mc.n), 0)::int AS trophies, COUNT(*)::int AS winning_teams
         FROM event_results er
         JOIN registrations r ON r.id = er.registration_id
         JOIN events e ON e.id = er.event_id
         JOIN teams t ON t.id = r.team_id
         JOIN LATERAL (SELECT COUNT(*)::int AS n FROM team_members tm WHERE tm.team_id = t.id) mc ON TRUE
        WHERE r.year_id = $1 AND e.event_kind = 'team' AND er.is_published = TRUE
          AND COALESCE(er.is_disqualified, FALSE) = FALSE AND er.prize_place IN (1,2,3)`, [yearId]);
    const teamDecided = tdec[0] || { trophies: 0, winning_teams: 0 };

    const individualProjectedTotal = first + second + third;
    res.json({
      year_id: yearId,
      individual: {
        projected: { first, second, third, total: individualProjectedTotal },
        cells_total: cells.length,
        cells_published: cellsPublished,
        decided_published: { first: dmap[1], second: dmap[2], third: dmap[3],
          additional_3rd: extraMap.additional_3rd, consolation: extraMap.consolation },
        cells: cellRows,
      },
      team: {
        trophies: teamTrophies,
        winning_teams: teamWinningTeams,
        total_teams: teamTotalTeams,
        decided: { trophies: teamDecided.trophies, winning_teams: teamDecided.winning_teams },
        cells: teamCellRows,
      },
      grand_total: individualProjectedTotal + teamTrophies,
    });
  } catch (err) { next(err); }
});

module.exports = router;

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
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate, requireRole('Chairman', 'SuperAdmin'));

async function resolveYearId(param) {
  if (param && param !== 'active') return Number(param);
  const { rows } = await pool.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
  return rows[0]?.id || null;
}

// Teacher Awards (rule #17), Dance and Music awarded SEPARATELY. A normalised
// key (case-insensitive, trimmed, single-spaced) groups spelling variants so a
// teacher isn't split across rows; the display name is the most common spelling.
// Genuinely different spellings are merged by staff with the clean-up tool.
const tkey = (field) => `lower(btrim(regexp_replace(reg.${field}, '\\s+', ' ', 'g')))`;

// Best Teacher for ONE category (field = dance_teacher | music_teacher).
const teacherAwardSql = (field) => `
  SELECT mode() WITHIN GROUP (ORDER BY btrim(regexp_replace(reg.${field}, '\\s+', ' ', 'g'))) AS teacher_name,
         ${tkey(field)} AS tkey,
         ROUND(SUM(er.total_points)::numeric, 2) AS total_points,
         COUNT(*)::int AS entries
  FROM event_results er JOIN registrations reg ON reg.id = er.registration_id
  WHERE reg.year_id = $1 AND er.is_finalised = TRUE
    AND reg.${field} IS NOT NULL AND reg.${field} <> 'NOT_APPLICABLE' AND btrim(reg.${field}) <> ''
  GROUP BY ${tkey(field)}
  ORDER BY total_points DESC NULLS LAST, teacher_name`;

// All teachers in a category (finalised or not) — drives the clean-up tool.
const teacherListSql = (field) => `
  SELECT mode() WITHIN GROUP (ORDER BY btrim(regexp_replace(reg.${field}, '\\s+', ' ', 'g'))) AS teacher_name,
         ${tkey(field)} AS tkey,
         COUNT(*)::int AS entries,
         COUNT(DISTINCT btrim(reg.${field}))::int AS spellings,
         ROUND(COALESCE(SUM(er.total_points) FILTER (WHERE er.is_finalised), 0)::numeric, 2) AS total_points
  FROM registrations reg
  LEFT JOIN event_results er ON er.registration_id = reg.id
  WHERE reg.year_id = $1 AND reg.${field} IS NOT NULL AND reg.${field} <> 'NOT_APPLICABLE' AND btrim(reg.${field}) <> ''
  GROUP BY ${tkey(field)}
  ORDER BY teacher_name`;

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

    const { rows: danceTeacherAwards } = await pool.query(teacherAwardSql('dance_teacher'), [yearId]);
    const { rows: musicTeacherAwards } = await pool.query(teacherAwardSql('music_teacher'), [yearId]);
    const { rows: ageGroupToppers } = await pool.query(ageGroupToppersSql, [yearId]);
    const { rows: categoryToppers } = await pool.query(categoryToppersSql, [yearId]);

    res.json({ year_id: yearId, school_awards: schoolAwards, group_championship: groupChampionship,
      dance_teacher_awards: danceTeacherAwards, music_teacher_awards: musicTeacherAwards,
      age_group_toppers: ageGroupToppers, category_toppers: categoryToppers });
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
    const category = req.query.category === 'music' ? 'music' : 'dance';
    const field = category === 'music' ? 'music_teacher' : 'dance_teacher';
    // Match by normalised key so every spelling/case variant of this teacher is
    // included; ordered by participant name.
    const { rows } = await pool.query(
      `SELECT COALESCE(p.full_name, tm.team_name) AS entry_name,
              (reg.team_id IS NOT NULL) AS is_team,
              sch.name AS school,
              e.event_code, e.event_name, c.name AS category_name,
              ag.code AS age_group_code, ag.label AS age_group_label,
              er.prize_place, er.grade, er.total_points,
              '${category === 'music' ? 'Music' : 'Dance'}' AS taught_as
         FROM event_results er
         JOIN registrations reg ON reg.id = er.registration_id
         JOIN events e ON e.id = reg.event_id
         LEFT JOIN categories c ON c.id = e.category_id
         LEFT JOIN age_groups ag ON ag.id = reg.age_group_id
         LEFT JOIN participants p ON p.id = reg.participant_id
         LEFT JOIN teams tm ON tm.id = reg.team_id
         LEFT JOIN schools sch ON sch.id = COALESCE(p.school_id, tm.school_id)
        WHERE reg.year_id = $1 AND er.is_finalised = TRUE
          AND reg.${field} <> 'NOT_APPLICABLE'
          AND lower(btrim(regexp_replace(COALESCE(reg.${field}, ''), '\s+', ' ', 'g')))
            = lower(btrim(regexp_replace($2, '\s+', ' ', 'g')))
        ORDER BY entry_name`,
      [yearId, teacher]);
    res.json({ teacher, category, entries: rows });
  } catch (err) { next(err); }
});

// GET /api/admin/awards/:year_id/teachers?category=dance|music — distinct
// teachers (sorted by name) with entry counts and points, for the clean-up tool.
router.get('/:year_id/teachers', async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.params.year_id);
    if (!yearId) return res.status(400).json({ error: 'No active year' });
    const field = req.query.category === 'music' ? 'music_teacher' : 'dance_teacher';
    const { rows } = await pool.query(teacherListSql(field), [yearId]);
    res.json({ category: field === 'music_teacher' ? 'music' : 'dance', teachers: rows });
  } catch (err) { next(err); }
});

// POST /api/admin/awards/:year_id/teachers/rename { category, from, to }
// Merge/rename a teacher: set every registration whose <category>_teacher matches
// `from` (case/space-insensitive) to `to`. Merges if `to` already exists.
router.post('/:year_id/teachers/rename', async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.params.year_id);
    if (!yearId) return res.status(400).json({ error: 'No active year' });
    const field = req.body.category === 'music' ? 'music_teacher' : 'dance_teacher';
    const from = String(req.body.from || '').trim();
    const to = String(req.body.to || '').trim();
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
    const { rows } = await pool.query(
      `UPDATE registrations SET ${field} = $3, updated_at = now()
        WHERE year_id = $1 AND ${field} IS NOT NULL AND ${field} <> 'NOT_APPLICABLE'
          AND lower(btrim(regexp_replace(${field}, '\s+', ' ', 'g')))
            = lower(btrim(regexp_replace($2, '\s+', ' ', 'g')))
        RETURNING id`, [yearId, from, to]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'RENAME_TEACHER', entity: 'registrations',
      details: { category: field, from, to, updated: rows.length } });
    res.json({ updated: rows.length, from, to });
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
    const { rows: danceT } = await pool.query(teacherAwardSql('dance_teacher'), [yearId]);
    const { rows: musicT } = await pool.query(teacherAwardSql('music_teacher'), [yearId]);
    lines.push('');
    lines.push('BEST DANCE TEACHER (rule #17)');
    lines.push('teacher,entries,total_points');
    danceT.forEach((r) => lines.push([r.teacher_name, r.entries, r.total_points].map(q).join(',')));
    lines.push('');
    lines.push('BEST MUSIC TEACHER (rule #17)');
    lines.push('teacher,entries,total_points');
    musicT.forEach((r) => lines.push([r.teacher_name, r.entries, r.total_points].map(q).join(',')));
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
async function computeTrophyCount(yearId) {
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
    let teamFirst = 0, teamSecond = 0, teamThird = 0;
    const teamCellRows = [];
    for (const cell of teamCells.values()) {
      const sizes = cell.sizes.slice().sort((a, b) => b - a);
      const winners = Math.min(sizes.length, 3);
      // Projection assigns 1st to the largest team, 2nd to the next, 3rd to the next.
      const p1 = winners >= 1 ? (sizes[0] || 0) : 0;
      const p2 = winners >= 2 ? (sizes[1] || 0) : 0;
      const p3 = winners >= 3 ? (sizes[2] || 0) : 0;
      const trophies = p1 + p2 + p3;
      teamFirst += p1; teamSecond += p2; teamThird += p3;
      teamTrophies += trophies; teamWinningTeams += winners; teamTotalTeams += sizes.length;
      teamCellRows.push({ event_code: cell.event_code, event_name: cell.event_name,
        age_group_code: cell.age_group_code, teams: sizes.length,
        winning_teams: winners, first: p1, second: p2, third: p3, trophies });
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
    return {
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
        projected: { first: teamFirst, second: teamSecond, third: teamThird, total: teamTrophies },
        trophies: teamTrophies,
        winning_teams: teamWinningTeams,
        total_teams: teamTotalTeams,
        decided: { trophies: teamDecided.trophies, winning_teams: teamDecided.winning_teams },
        cells: teamCellRows,
      },
      grand_total: individualProjectedTotal + teamTrophies,
    };
}

router.get('/:year_id/trophy-count', async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.params.year_id);
    if (!yearId) return res.status(400).json({ error: 'No active year' });
    res.json(await computeTrophyCount(yearId));
  } catch (err) { next(err); }
});

// GET /api/admin/awards/:year_id/trophy-count-xlsx — shop order workbook.
router.get('/:year_id/trophy-count-xlsx', async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.params.year_id);
    if (!yearId) return res.status(400).json({ error: 'No active year' });
    const { rows: yc } = await pool.query(
      `SELECT event_year_label FROM year_config WHERE id = $1`, [yearId]);
    const yearLabel = yc[0] && yc[0].event_year_label ? yc[0].event_year_label : 'ITS';
    const d = await computeTrophyCount(yearId);
    const ip = d.individual.projected, tp = d.team.projected;

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'KCA ITS'; wb.created = new Date();

    // Sheet 1 — Shop Order (what to send the trophy shop).
    const ws = wb.addWorksheet('Shop Order');
    ws.mergeCells('A1:C1');
    ws.getCell('A1').value = `Trophy order \u2014 ${yearLabel}`;
    ws.getCell('A1').font = { bold: true, size: 14 };
    ws.addRow([]);
    const head = ws.addRow(['Trophy type', 'Place', 'Quantity']);
    head.font = { bold: true };
    head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } }; });
    const rows = [
      ['Individual', '1st place', ip.first],
      ['Individual', '2nd place', ip.second],
      ['Individual', '3rd place', ip.third],
      ['Individual', 'Subtotal', ip.total],
      ['Team', '1st place', tp.first],
      ['Team', '2nd place', tp.second],
      ['Team', '3rd place', tp.third],
      ['Team', 'Subtotal', tp.total],
    ];
    rows.forEach((r) => {
      const row = ws.addRow(r);
      if (r[1] === 'Subtotal') row.font = { bold: true, italic: true };
    });
    const grand = ws.addRow(['TOTAL (all trophies)', '', d.grand_total]);
    grand.font = { bold: true };
    ws.columns = [{ width: 24 }, { width: 14 }, { width: 12 }];
    ws.addRow([]);
    const note = ws.addRow(['Note: Individual and Team trophies are different types. Figures are the projected maximum from current entries. Team places go to EVERY member of a winning team; per contest the top 3 teams win (fewer if fewer than 3 teams).']);
    ws.mergeCells(note.number, 1, note.number, 3);
    note.getCell(1).alignment = { wrapText: true };
    note.getCell(1).font = { italic: true, color: { argb: 'FF666666' } };
    ws.getRow(note.number).height = 46;

    // Sheet 2 — Individual detail.
    const wi = wb.addWorksheet('Individual detail');
    wi.columns = [
      { header: 'Event', key: 'ev', width: 34 },
      { header: 'Group', key: 'ag', width: 10 },
      { header: 'Entrants', key: 'n', width: 10 },
      { header: '1st', key: 'p1', width: 6 },
      { header: '2nd', key: 'p2', width: 6 },
      { header: '3rd', key: 'p3', width: 6 },
      { header: 'Trophies', key: 't', width: 10 },
    ];
    d.individual.cells.forEach((r) => wi.addRow({
      ev: `${r.event_code} ${r.event_name}`, ag: r.age_group_code,
      n: r.entrants, p1: r.entrants >= 1 ? 1 : 0, p2: r.entrants >= 2 ? 1 : 0,
      p3: r.entrants >= 3 ? 1 : 0, t: r.trophies }));
    wi.getRow(1).font = { bold: true };
    wi.views = [{ state: 'frozen', ySplit: 1 }];

    // Sheet 3 — Team detail (members per winning place).
    const wt = wb.addWorksheet('Team detail');
    wt.columns = [
      { header: 'Event', key: 'ev', width: 36 },
      { header: 'Group', key: 'ag', width: 10 },
      { header: 'Teams', key: 'teams', width: 8 },
      { header: 'Winning', key: 'win', width: 9 },
      { header: '1st (members)', key: 'p1', width: 14 },
      { header: '2nd (members)', key: 'p2', width: 14 },
      { header: '3rd (members)', key: 'p3', width: 14 },
      { header: 'Trophies', key: 't', width: 10 },
    ];
    d.team.cells.forEach((r) => wt.addRow({
      ev: `${r.event_code} ${r.event_name}`, ag: r.age_group_code || '',
      teams: r.teams, win: r.winning_teams, p1: r.first, p2: r.second, p3: r.third, t: r.trophies }));
    wt.getRow(1).font = { bold: true };
    wt.views = [{ state: 'frozen', ySplit: 1 }];

    const buf = await wb.xlsx.writeBuffer();
    const label = String(yearLabel).replace(/[^A-Za-z0-9]+/g, '-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="trophy-order-${label}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) { next(err); }
});

module.exports = router;

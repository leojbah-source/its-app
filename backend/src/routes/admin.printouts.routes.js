// src/routes/admin.printouts.routes.js  (mounted at /api/admin/printouts)
// Data for branded HTML print-outs (rule #2 logos come from year_config):
//   /certificates/:year_id  — one winner per finalised prize placement
//   /judge-review/:year_id  — judge flags + refusal statements + blacklist (rule #9/#10)
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

async function resolveYearId(param) {
  if (param && param !== 'active') return Number(param);
  const { rows } = await pool.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
  return rows[0]?.id || null;
}
async function branding() {
  const { rows } = await pool.query(
    `SELECT event_year_label, kca_logo_url, sponsor_logo_url, sponsor_name FROM year_config WHERE is_active = TRUE LIMIT 1`);
  return rows[0] || null;
}

// GET /api/admin/printouts/certificates/:year_id  (Chairman/Admin/SuperAdmin)
router.get('/certificates/:year_id', requireRole('SuperAdmin', 'Admin', 'Chairman'), async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.params.year_id);
    if (!yearId) return res.status(400).json({ error: 'No active year' });
    const { rows: winners } = await pool.query(
      `SELECT er.prize_place, er.grade,
              COALESCE(p.full_name, t.team_name) AS name,
              e.event_name, c.name AS category_name, ag.label AS age_group_label
       FROM event_results er
       JOIN registrations r ON r.id = er.registration_id
       JOIN events e ON e.id = er.event_id
       LEFT JOIN participants p ON p.id = r.participant_id
       LEFT JOIN teams t ON t.id = r.team_id
       LEFT JOIN categories c ON c.id = e.category_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       WHERE r.year_id = $1 AND er.is_finalised = TRUE AND er.prize_place IN (1,2,3)
       ORDER BY e.event_name, ag.label, er.prize_place`, [yearId]);
    res.json({ branding: await branding(), winners });
  } catch (err) { next(err); }
});

// GET /api/admin/printouts/judge-review/:year_id  (Chairman/SuperAdmin — rule #9/#10/#11)
router.get('/judge-review/:year_id', requireRole('Chairman', 'SuperAdmin'), async (req, res, next) => {
  try {
    const yearId = await resolveYearId(req.params.year_id);
    if (!yearId) return res.status(400).json({ error: 'No active year' });
    const { rows: flags } = await pool.query(
      `SELECT jf.flag_type, jf.statement, jf.flagged_at, jf.reviewed_by_chairman,
              j.full_name AS judge_name, e.event_name
       FROM judge_flags jf
       JOIN judges j ON j.id = jf.judge_id
       LEFT JOIN events e ON e.id = jf.event_id
       WHERE jf.year_id = $1 ORDER BY jf.flagged_at DESC`, [yearId]);
    const { rows: blacklist } = await pool.query(
      `SELECT full_name, blacklist_reason, blacklist_date FROM judges
       WHERE is_blacklisted = TRUE ORDER BY full_name`);
    res.json({ branding: await branding(), flags, blacklist });
  } catch (err) { next(err); }
});

module.exports = router;

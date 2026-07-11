// src/routes/admin.lists.routes.js  (mounted at /api/admin/lists)
//
// Post-registration lists (Blueprint: initial list publication + final list):
//   GET  /by-event        — events with their participants (for event-wise
//                           printed lists, grouped by age group)
//   GET  /by-participant  — participants with their events (distributed to
//                           each registered participant for confirmation)
//   GET  /final           — final roster of participants + totals
//   POST /publish-initial — stamps year_config.initial_list_published
//
// DB-verified columns: registrations(status enum, participant_id, event_id,
// age_group_id), participants(full_name, cpr_number, school_id, created_by,
// admin_verified_status), year_config(initial_list_published[_at]).

const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

const staffRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'];

async function activeYear() {
  const { rows } = await pool.query(
    `SELECT id, event_year_label, kca_logo_url, its_logo_url, sponsor_logo_url, sponsor_name,
            initial_list_published, initial_list_published_at
     FROM year_config WHERE is_active = TRUE LIMIT 1`);
  return rows[0] || null;
}

// ── GET /api/admin/lists/by-event ─────────────────────────────────────────────
router.get('/by-event', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });

    const { rows } = await pool.query(
      `SELECT e.id AS event_id, e.event_code, e.event_name, e.event_kind,
              c.name AS category_name,
              ag.code AS age_group_code, ag.label AS age_group_label,
              p.id AS participant_id, p.full_name, p.cpr_number,
              t.team_name, s.name AS school_name
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       LEFT JOIN categories c ON c.id = e.category_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       LEFT JOIN participants p ON p.id = r.participant_id
       LEFT JOIN teams t ON t.id = r.team_id
       LEFT JOIN schools s ON s.id = p.school_id
       WHERE r.year_id = $1 AND r.status NOT IN ('withdrawn','swapped')
         AND e.is_cancelled = FALSE
       ORDER BY c.sort_order NULLS LAST, e.event_code, ag.sort_order, p.full_name`,
      [yc.id]);

    // shape: events[] each with entries[] (participant or team)
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.event_id)) {
        map.set(r.event_id, {
          event_id: r.event_id, event_code: r.event_code, event_name: r.event_name,
          event_kind: r.event_kind, category_name: r.category_name, entries: [],
        });
      }
      map.get(r.event_id).entries.push({
        name: r.full_name || `${r.team_name} (team)`,
        cpr_number: r.cpr_number,
        school_name: r.school_name,
        age_group_code: r.age_group_code,
        age_group_label: r.age_group_label,
      });
    }
    res.json({ year: yc, events: [...map.values()] });
  } catch (err) { next(err); }
});

// ── GET /api/admin/lists/by-participant ──────────────────────────────────────
router.get('/by-participant', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });

    const { rows } = await pool.query(
      `SELECT p.id, p.full_name, p.cpr_number, p.admin_verified_status,
              ag.code AS age_group_code, ag.label AS age_group_label,
              s.name AS school_name,
              u.full_name AS parent_name, COALESCE(u.whatsapp_number, u.phone) AS parent_contact,
              e.event_code, e.event_name, cat.name AS category_name
       FROM participants p
       LEFT JOIN age_groups ag ON ag.id = p.age_group_id
       LEFT JOIN schools s ON s.id = p.school_id
       LEFT JOIN users u ON u.id = p.created_by
       JOIN registrations r ON r.participant_id = p.id
         AND r.status NOT IN ('withdrawn','swapped')
       JOIN events e ON e.id = r.event_id AND e.is_cancelled = FALSE
       LEFT JOIN categories cat ON cat.id = e.category_id
       WHERE p.year_id = $1
       ORDER BY ag.sort_order, p.full_name, e.event_code`,
      [yc.id]);

    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.id)) {
        map.set(r.id, {
          participant_id: r.id, full_name: r.full_name, cpr_number: r.cpr_number,
          age_group_code: r.age_group_code, age_group_label: r.age_group_label,
          school_name: r.school_name, parent_name: r.parent_name,
          parent_contact: r.parent_contact,
          admin_verified_status: r.admin_verified_status,
          events: [],
        });
      }
      map.get(r.id).events.push({
        event_code: r.event_code, event_name: r.event_name, category_name: r.category_name,
      });
    }
    res.json({ year: yc, participants: [...map.values()] });
  } catch (err) { next(err); }
});

// ── GET /api/admin/lists/final ────────────────────────────────────────────────
// Final roster + headline totals (participants, entries, per-group counts).
router.get('/final', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const yc = await activeYear();
    if (!yc) return res.status(400).json({ error: 'No active year' });

    const { rows } = await pool.query(
      `SELECT p.id, p.full_name, p.cpr_number, p.gender,
              ag.code AS age_group_code, s.name AS school_name,
              COUNT(r.id)::int AS event_count,
              string_agg(e.event_code, ', ' ORDER BY e.event_code) AS event_codes,
              json_agg(json_build_object('event_code', e.event_code, 'event_name', e.event_name)
                       ORDER BY e.event_code) AS events
       FROM participants p
       LEFT JOIN age_groups ag ON ag.id = p.age_group_id
       LEFT JOIN schools s ON s.id = p.school_id
       JOIN registrations r ON r.participant_id = p.id
         AND r.status NOT IN ('withdrawn','swapped')
       JOIN events e ON e.id = r.event_id AND e.is_cancelled = FALSE
       WHERE p.year_id = $1
       GROUP BY p.id, ag.code, ag.sort_order, s.name
       ORDER BY ag.sort_order, p.full_name`,
      [yc.id]);

    const byGroup = {};
    for (const r of rows) byGroup[r.age_group_code || '—'] = (byGroup[r.age_group_code || '—'] || 0) + 1;
    const totals = {
      participants: rows.length,
      entries: rows.reduce((t, r) => t + r.event_count, 0),
      by_group: byGroup,
    };
    res.json({ year: yc, totals, participants: rows });
  } catch (err) { next(err); }
});

// ── POST /api/admin/lists/publish-initial ────────────────────────────────────
router.post('/publish-initial', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE year_config SET initial_list_published = TRUE,
              initial_list_published_at = NOW(), updated_at = NOW()
       WHERE is_active = TRUE
       RETURNING id, initial_list_published, initial_list_published_at`);
    if (!rows[0]) return res.status(400).json({ error: 'No active year' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'PUBLISH_INITIAL_LIST', entity: 'year_config', entityId: rows[0].id,
      reason: 'Initial registration lists published for distribution' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
